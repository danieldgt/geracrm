import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { exigirTenant } from '../../plugins/tenant.js'
import { garantirUsuarioId } from '../atendimento/rotas-fila.js'

/**
 * Sequências (régua de relacionamento) — CRUD do playbook + aplicação.
 *
 * ⚠️ Aplicar a um contato MATERIALIZA tarefas (0039), vencimento = hoje + offset
 * de cada passo. Sem worker, sem estado de execução novo — reusa `tarefa`. O
 * enrolamento automático (disparar pela mudança de segmento/etapa) é do motor de
 * Automações e vem depois. Tenant sempre de tenant_atual() (ADR-001).
 */
export async function rotasSequencia(app: FastifyInstance): Promise<void> {
  // Listagem (conjunto pequeno) com contagem de passos.
  app.get('/v1/sequencias', { preHandler: exigirTenant }, async (req, reply) => {
    const linhas = await req.comTenant((tx) => tx<{ id: string; nome: string; objetivo: string | null; ativa: boolean; passos: number }[]>`
      SELECT s.id, s.nome, s.objetivo, s.ativa,
             (SELECT count(*)::int FROM sequencia_passo p WHERE p.tenant_id = s.tenant_id AND p.sequencia_id = s.id) AS passos
        FROM sequencia s
       WHERE s.tenant_id = tenant_atual()
       ORDER BY s.nome ASC LIMIT 200`)
    return reply.send({ itens: linhas.map((l) => ({ id: l.id, nome: l.nome, objetivo: l.objetivo, ativa: l.ativa, passos: l.passos })) })
  })

  app.post<{ Body: { nome?: string; objetivo?: string } }>(
    '/v1/sequencias', { preHandler: exigirTenant },
    async (req, reply) => {
      const nome = req.body?.nome?.trim()
      if (!nome) return reply.code(422).send({ erro: 'sequencia.nome_obrigatorio', mensagem: 'Dê um nome à sequência.' })
      const id = randomUUID()
      try {
        await req.comTenant(async (tx) => {
          const eu = await garantirUsuarioId(tx, req)
          await tx`INSERT INTO sequencia (tenant_id, id, nome, objetivo, criado_por)
                   VALUES (tenant_atual(), ${id}, ${nome}, ${req.body?.objetivo?.trim() || null}, ${eu})`
        })
        return reply.code(201).send({ id })
      } catch (e) {
        if (e instanceof Error && e.message.includes('sequencia_nome_unico')) {
          return reply.code(409).send({ erro: 'sequencia.nome_duplicado', mensagem: 'Já existe uma sequência com esse nome.' })
        }
        throw e
      }
    },
  )

  app.patch<{ Params: { id: string }; Body: { nome?: string; objetivo?: string; ativa?: boolean } }>(
    '/v1/sequencias/:id', { preHandler: exigirTenant },
    async (req, reply) => {
      const nome = req.body?.nome?.trim()
      const [r] = await req.comTenant((tx) => tx`
        UPDATE sequencia SET
           nome     = COALESCE(${nome ?? null}, nome),
           objetivo = COALESCE(${req.body?.objetivo?.trim() ?? null}, objetivo),
           ativa    = COALESCE(${req.body?.ativa ?? null}, ativa)
         WHERE tenant_id = tenant_atual() AND id = ${req.params.id} RETURNING id`)
      if (!r) return reply.code(404).send({ erro: 'sequencia.nao_encontrada' })
      return reply.send({ ok: true })
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/v1/sequencias/:id', { preHandler: exigirTenant },
    async (req, reply) => {
      const [r] = await req.comTenant((tx) => tx`
        DELETE FROM sequencia WHERE tenant_id = tenant_atual() AND id = ${req.params.id} RETURNING id`)
      if (!r) return reply.code(404).send({ erro: 'sequencia.nao_encontrada' })
      return reply.send({ ok: true })
    },
  )

  // Passos da sequência (ordenados).
  app.get<{ Params: { id: string } }>(
    '/v1/sequencias/:id/passos', { preHandler: exigirTenant },
    async (req, reply) => {
      const linhas = await req.comTenant((tx) => tx<{ seq: number; offset_dias: number; titulo: string; descricao: string | null }[]>`
        SELECT seq, offset_dias, titulo, descricao FROM sequencia_passo
         WHERE tenant_id = tenant_atual() AND sequencia_id = ${req.params.id}
         ORDER BY offset_dias ASC, seq ASC`)
      return reply.send({ itens: linhas.map((l) => ({ seq: l.seq, offsetDias: l.offset_dias, titulo: l.titulo, descricao: l.descricao })) })
    },
  )

  // Adicionar passo (seq = próximo).
  app.post<{ Params: { id: string }; Body: { offsetDias?: number; titulo?: string; descricao?: string } }>(
    '/v1/sequencias/:id/passos', { preHandler: exigirTenant },
    async (req, reply) => {
      const titulo = req.body?.titulo?.trim()
      const offsetDias = req.body?.offsetDias
      if (!titulo) return reply.code(422).send({ erro: 'passo.titulo_obrigatorio', mensagem: 'Diga o que fazer neste passo.' })
      if (!Number.isInteger(offsetDias) || offsetDias! < 0) return reply.code(422).send({ erro: 'passo.offset_invalido', mensagem: 'Informe D+N (dias ≥ 0).' })
      try {
        const seq = await req.comTenant(async (tx) => {
          // Garante a existência da sequência (senão a FK dá erro genérico).
          const [existe] = await tx<{ id: string }[]>`SELECT id FROM sequencia WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
          if (!existe) return null
          const [linha] = await tx<{ prox: number }[]>`
            SELECT COALESCE(max(seq), 0) + 1 AS prox FROM sequencia_passo
             WHERE tenant_id = tenant_atual() AND sequencia_id = ${req.params.id}`
          const prox = linha!.prox
          await tx`INSERT INTO sequencia_passo (tenant_id, sequencia_id, seq, offset_dias, titulo, descricao)
                   VALUES (tenant_atual(), ${req.params.id}, ${prox}, ${offsetDias!}, ${titulo}, ${req.body?.descricao?.trim() || null})`
          return prox
        })
        if (seq === null) return reply.code(404).send({ erro: 'sequencia.nao_encontrada' })
        return reply.code(201).send({ seq })
      } catch (e) { throw e }
    },
  )

  app.delete<{ Params: { id: string; seq: string } }>(
    '/v1/sequencias/:id/passos/:seq', { preHandler: exigirTenant },
    async (req, reply) => {
      const [r] = await req.comTenant((tx) => tx`
        DELETE FROM sequencia_passo
         WHERE tenant_id = tenant_atual() AND sequencia_id = ${req.params.id} AND seq = ${Number(req.params.seq)}
         RETURNING seq`)
      if (!r) return reply.code(404).send({ erro: 'passo.nao_encontrado' })
      return reply.send({ ok: true })
    },
  )

  // ⚠️ Aplicar a um contato: materializa uma tarefa por passo (vence = hoje + offset).
  app.post<{ Params: { id: string }; Body: { contatoId?: string } }>(
    '/v1/sequencias/:id/aplicar', { preHandler: exigirTenant },
    async (req, reply) => {
      const contatoId = req.body?.contatoId
      if (!contatoId) return reply.code(422).send({ erro: 'sequencia.contato_obrigatorio' })
      const resultado = await req.comTenant(async (tx) => {
        const [seqExiste] = await tx<{ id: string }[]>`SELECT id FROM sequencia WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        if (!seqExiste) return { erro: 'sequencia' as const }
        const [contExiste] = await tx<{ id: string }[]>`SELECT id FROM contato WHERE tenant_id = tenant_atual() AND id = ${contatoId}`
        if (!contExiste) return { erro: 'contato' as const }
        const passos = await tx<{ offset_dias: number; titulo: string; descricao: string | null }[]>`
          SELECT offset_dias, titulo, descricao FROM sequencia_passo
           WHERE tenant_id = tenant_atual() AND sequencia_id = ${req.params.id} ORDER BY seq ASC`
        if (passos.length === 0) return { criadas: 0 }
        const eu = await garantirUsuarioId(tx, req)
        for (const p of passos) {
          await tx`INSERT INTO tarefa (tenant_id, id, contato_id, responsavel_id, titulo, descricao, vence_em, criado_por)
                   VALUES (tenant_atual(), ${randomUUID()}, ${contatoId}, ${eu}, ${p.titulo}, ${p.descricao},
                           date_trunc('day', now()) + (${p.offset_dias} || ' days')::interval + interval '9 hours', ${eu})`
        }
        return { criadas: passos.length }
      })
      if ('erro' in resultado) {
        return resultado.erro === 'sequencia'
          ? reply.code(404).send({ erro: 'sequencia.nao_encontrada' })
          : reply.code(422).send({ erro: 'sequencia.contato_invalido', mensagem: 'Contato não encontrado.' })
      }
      return reply.send({ ok: true, tarefasCriadas: resultado.criadas })
    },
  )
}
