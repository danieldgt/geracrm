import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Sql } from '../../db/index.js'
import { exigirTenant } from '../../plugins/tenant.js'
import { auditar } from '../plataforma/auditoria.js'
import { garantirEtapasAtendimento } from './rotas-atendimento-kanban.js'

/**
 * Fila e assunção (EP-06).
 *
 * ⚠️ "Assumir atendimento" é vencedor ATÔMICO por índice único (INV-51:
 * `atendimento_aberto_unico`), NUNCA `SELECT` antes de `INSERT`. Em 50 assunções
 * concorrentes da mesma conversa, exatamente 1 vence; as outras recebem erro
 * tipificado — e a tela já atualizou pelo tempo real.
 */

/**
 * Garante o `usuario` do chamador (por cognito_sub) e devolve o id.
 *
 * ⚠️ O conflito é resolvido por `(tenant_id, cognito_sub)`, não por `cognito_sub`
 * sozinho: a MESMA pessoa pode ser usuária de dois clientes nossos — consultor,
 * contador, e o staff que entra no cliente pelo PLT-05. Com o único global, a
 * segunda empresa caía no UPDATE de uma linha de OUTRO tenant, o RLS FORCE
 * recusava, o `RETURNING` voltava vazio e a rota estourava em 500. Vale para os
 * ~25 pontos que chamam esta função — praticamente toda escrita do produto.
 * A chave composta nasce na migration 0081; o único global sai na 0082.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function garantirUsuarioId(tx: Sql, req: FastifyRequest): Promise<string> {
  // Dev (header x-tenant-id, sem Cognito): sub sintético por tenant, para duas
  // empresas locais não disputarem a mesma linha.
  const sub = req.usuarioSub ?? `dev-${req.tenantId ?? 'sem-tenant'}`
  const email = req.usuarioEmail ?? 'dogfooding@geracrm.local'
  const nome = (email.split('@')[0] ?? 'Atendente') || 'Atendente'
  const [u] = await tx<{ id: string }[]>`
    INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email)
    VALUES (tenant_atual(), ${randomUUID()}, ${sub}, ${nome}, ${email})
    ON CONFLICT (tenant_id, cognito_sub) DO UPDATE SET email = EXCLUDED.email
    RETURNING id`
  return u!.id
}

async function emitirEvento(tx: Sql, conversaId: string): Promise<void> {
  const [conv] = await tx<{ versao: string }[]>`
    UPDATE conversa SET versao = versao + 1
     WHERE tenant_id = tenant_atual() AND id = ${conversaId} RETURNING versao`
  await tx`
    INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id, payload)
    VALUES (tenant_atual(), 'atendimento.mudou', 'conversa', ${conversaId},
            ${JSON.stringify({ conversaId, versao: Number(conv?.versao ?? 0) })}::text::jsonb)`
}

export async function rotasFila(app: FastifyInstance): Promise<void> {
  /** Busca de conversa por PROTOCOLO (E5-08). O número é a identidade. */
  app.get<{ Querystring: { p?: string } }>(
    '/v1/conversas/por-protocolo',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const p = Number(req.query.p)
      if (!Number.isSafeInteger(p) || p <= 0) return reply.code(422).send({ erro: 'protocolo.invalido' })
      const [row] = await req.comTenant((tx) => tx<{ conversa_id: string }[]>`
        SELECT conversa_id FROM atendimento
         WHERE tenant_id = tenant_atual() AND protocolo = ${p}
         ORDER BY criado_em DESC LIMIT 1`)
      if (!row) return reply.code(404).send({ erro: 'protocolo.nao_encontrado' })
      return reply.send({ conversaId: row.conversa_id })
    },
  )

  /** Contadores das abas (E6-02): fila (não assumidas) e meus (em atendimento). */
  app.get('/v1/fila/contadores', { preHandler: exigirTenant }, async (req, reply) => {
    const sub = req.usuarioSub ?? 'dev-header-sub'
    const r = await req.comTenant(async (tx) => {
      const [fila] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM conversa cv
         WHERE cv.tenant_id = tenant_atual() AND NOT cv.arquivada AND cv.ultima_direcao = 'entrante'
           AND NOT EXISTS (SELECT 1 FROM atendimento a
                            WHERE a.tenant_id = cv.tenant_id AND a.conversa_id = cv.id AND a.estado <> 'encerrado')`
      const [meus] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM atendimento a
         JOIN usuario u ON u.tenant_id = a.tenant_id AND u.id = a.atendente_id
         WHERE a.tenant_id = tenant_atual() AND a.estado <> 'encerrado' AND u.cognito_sub = ${sub}`
      return { fila: fila?.n ?? 0, meus: meus?.n ?? 0 }
    })
    return reply.send(r)
  })

  /**
   * Assumir a conversa. `etapaId` (opcional) diz em QUAL etapa do painel o atendimento
   * nasce — é o que o kanban manda quando o gestor solta o card numa coluna; sem ela,
   * nasce na 1ª etapa de atendimento. ⚠️ Só etapa ATIVA do tipo 'atendimento': encerrar
   * é mover DEPOIS de assumir (`/atendimento-kanban/:id/mover`), nunca nascer encerrado —
   * um atendimento encerrado não tira a conversa da fila, e o card apareceria nas duas.
   */
  app.post<{ Params: { id: string }; Body: { etapaId?: string } | null }>(
    '/v1/conversas/:id/assumir',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const conversaId = req.params.id
      const etapaPedida = req.body?.etapaId
      const ETAPA_INVALIDA = { erro: 'etapa.invalida', mensagem: 'Solte o card numa etapa de atendimento ativa.' }
      if (etapaPedida !== undefined && !UUID.test(etapaPedida)) return reply.code(422).send(ETAPA_INVALIDA)
      const r = await req.comTenant(async (tx) => {
        const [conv] = await tx<{ canal_id: string }[]>`
          SELECT canal_id FROM conversa WHERE tenant_id = tenant_atual() AND id = ${conversaId}`
        if (!conv) return { tipo: 'nao_encontrada' as const }

        const usuarioId = await garantirUsuarioId(tx, req)
        await garantirEtapasAtendimento(tx)
        const [etapa] = etapaPedida
          ? await tx<{ id: string }[]>`
              SELECT id FROM atendimento_etapa
               WHERE tenant_id = tenant_atual() AND id = ${etapaPedida} AND ativo AND tipo = 'atendimento'`
          : await tx<{ id: string }[]>`
              SELECT id FROM atendimento_etapa
               WHERE tenant_id = tenant_atual() AND ativo AND tipo = 'atendimento' ORDER BY ordem LIMIT 1`
        if (etapaPedida && !etapa) return { tipo: 'etapa_invalida' as const }
        const atId = randomUUID()

        // ⚠️ Vencedor atômico: o índice parcial único recusa um 2º aberto.
        const [criado] = await tx<{ protocolo: string; etapa_id: string | null }[]>`
          INSERT INTO atendimento
            (tenant_id, id, conversa_id, canal_id, protocolo, atendente_id, estado, assumido_em, etapa_id, entrou_etapa_em)
          VALUES (tenant_atual(), ${atId}, ${conversaId}, ${conv.canal_id},
                  proximo_numero(tenant_atual(), 'protocolo'), ${usuarioId}, 'em_atendimento', now(),
                  ${etapa?.id ?? null}, now())
          ON CONFLICT (tenant_id, conversa_id) WHERE estado <> 'encerrado'
          DO NOTHING
          RETURNING protocolo, etapa_id`

        if (criado) {
          if (criado.etapa_id) {
            await tx`INSERT INTO atendimento_etapa_historico (tenant_id, id, atendimento_id, etapa_id, entrou_em, ator_id)
                     VALUES (tenant_atual(), ${randomUUID()}, ${atId}, ${criado.etapa_id}, now(), ${usuarioId})`
          }
          await emitirEvento(tx, conversaId)
          await auditar(tx, {
            atorId: usuarioId, acao: 'atendimento.assumido', entidade: 'conversa',
            entidadeId: conversaId, dados: { protocolo: Number(criado.protocolo) },
          })
          return { tipo: 'assumido' as const, protocolo: Number(criado.protocolo), meu: true, atendimentoId: atId }
        }

        // Já havia um atendimento aberto — quem tem?
        const [aberto] = await tx<{ atendente_id: string | null; nome: string | null; protocolo: string }[]>`
          SELECT a.atendente_id, u.nome, a.protocolo
            FROM atendimento a
            LEFT JOIN usuario u ON u.tenant_id = a.tenant_id AND u.id = a.atendente_id
           WHERE a.tenant_id = tenant_atual() AND a.conversa_id = ${conversaId} AND a.estado <> 'encerrado'`
        return {
          tipo: 'ja_aberto' as const,
          meu: aberto?.atendente_id === usuarioId,
          por: aberto?.nome ?? null,
          protocolo: Number(aberto?.protocolo ?? 0),
        }
      })

      if (r.tipo === 'nao_encontrada') return reply.code(404).send({ erro: 'conversa.nao_encontrada' })
      if (r.tipo === 'etapa_invalida') return reply.code(422).send(ETAPA_INVALIDA)
      if (r.tipo === 'assumido') return reply.code(201).send({ ok: true, protocolo: r.protocolo, meu: true, atendimentoId: r.atendimentoId })
      // Já aberto: se é meu, 200 ok; se é de outro, 409 tipificado.
      if (r.meu) return reply.code(200).send({ ok: true, protocolo: r.protocolo, meu: true })
      return reply.code(409).send({ erro: 'atendimento.ja_assumido', mensagem: `Em atendimento por ${r.por ?? 'outro atendente'}.`, por: r.por })
    },
  )
}
