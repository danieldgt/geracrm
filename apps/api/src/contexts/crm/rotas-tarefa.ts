import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { exigirTenant } from '../../plugins/tenant.js'
import { garantirUsuarioId } from '../atendimento/rotas-fila.js'

const PAGINA = 30

/**
 * Tarefas de follow-up (CRUD). ⚠️ Filtro por "situação" derivada:
 *   • abertas   = estado 'aberta'
 *   • vencidas  = 'aberta' E vence_em < now
 *   • hoje      = 'aberta' E vence_em no dia de hoje
 *   • concluidas
 * Ordena por vencimento (mais urgente primeiro). Cursor por (vence_em, id).
 */
export async function rotasTarefa(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { situacao?: string; contatoId?: string; cursor?: string } }>(
    '/v1/tarefas', { preHandler: exigirTenant },
    async (req, reply) => {
      let curEm: string | null = null, curId: string | null = null
      if (req.query.cursor) {
        const [em, id] = Buffer.from(req.query.cursor, 'base64url').toString('utf8').split('§')
        if (!em || !id) return reply.code(422).send({ erro: 'cursor.invalido' })
        curEm = em; curId = id
      }
      const { situacao, contatoId } = req.query
      const linhas = await req.comTenant((tx) => {
        const filtroSituacao =
          situacao === 'concluidas' ? tx`t.estado = 'concluida'`
          : situacao === 'vencidas' ? tx`t.estado = 'aberta' AND t.vence_em < now()`
          : situacao === 'hoje'     ? tx`t.estado = 'aberta' AND t.vence_em < date_trunc('day', now()) + interval '1 day'`
          : situacao === 'abertas'  ? tx`t.estado = 'aberta'`
          : tx`t.estado <> 'cancelada'`
        return tx<{
          id: string; titulo: string; descricao: string | null; vence_em: Date; estado: string
          concluida_em: Date | null; contato_id: string | null; contato: string | null; responsavel: string | null
        }[]>`
          SELECT t.id, t.titulo, t.descricao, t.vence_em, t.estado, t.concluida_em, t.contato_id,
                 c.nome AS contato, u.nome AS responsavel
            FROM tarefa t
            LEFT JOIN contato c ON c.tenant_id = t.tenant_id AND c.id = t.contato_id
            LEFT JOIN usuario u ON u.tenant_id = t.tenant_id AND u.id = t.responsavel_id
           WHERE t.tenant_id = tenant_atual() AND ${filtroSituacao}
             AND ${contatoId ? tx`t.contato_id = ${contatoId}` : tx`true`}
             AND ${curEm === null ? tx`true` : tx`(t.vence_em, t.id) > (${curEm}::timestamptz, ${curId}::uuid)`}
           ORDER BY t.vence_em ASC, t.id ASC LIMIT ${PAGINA + 1}`
      })
      const temMais = linhas.length > PAGINA
      const pagina = temMais ? linhas.slice(0, PAGINA) : linhas
      const ultimo = pagina[pagina.length - 1]
      const agora = Date.now()
      return reply.send({
        itens: pagina.map((l) => ({
          id: l.id, titulo: l.titulo, descricao: l.descricao, venceEm: l.vence_em, estado: l.estado,
          concluidaEm: l.concluida_em, contatoId: l.contato_id, contato: l.contato, responsavel: l.responsavel,
          vencida: l.estado === 'aberta' && l.vence_em.getTime() < agora,
        })),
        proximoCursor: temMais && ultimo
          ? Buffer.from(`${ultimo.vence_em.toISOString()}§${ultimo.id}`).toString('base64url') : null,
      })
    },
  )

  app.post<{ Body: { contatoId?: string; titulo?: string; descricao?: string; venceEm?: string } }>(
    '/v1/tarefas', { preHandler: exigirTenant },
    async (req, reply) => {
      const titulo = req.body?.titulo?.trim()
      const venceEm = req.body?.venceEm
      if (!titulo) return reply.code(422).send({ erro: 'tarefa.titulo_obrigatorio', mensagem: 'Dê um título.' })
      if (!venceEm || Number.isNaN(Date.parse(venceEm))) return reply.code(422).send({ erro: 'tarefa.vencimento_invalido', mensagem: 'Informe o vencimento.' })
      const id = randomUUID()
      await req.comTenant(async (tx) => {
        const eu = await garantirUsuarioId(tx, req)
        await tx`INSERT INTO tarefa (tenant_id, id, contato_id, responsavel_id, titulo, descricao, vence_em, criado_por)
                 VALUES (tenant_atual(), ${id}, ${req.body?.contatoId ?? null}, ${eu}, ${titulo},
                         ${req.body?.descricao ?? null}, ${venceEm}, ${eu})`
      })
      return reply.code(201).send({ id })
    },
  )

  app.post<{ Params: { id: string } }>(
    '/v1/tarefas/:id/concluir', { preHandler: exigirTenant },
    async (req, reply) => {
      const [r] = await req.comTenant((tx) => tx`
        UPDATE tarefa SET estado = 'concluida', concluida_em = now()
         WHERE tenant_id = tenant_atual() AND id = ${req.params.id} AND estado = 'aberta' RETURNING id`)
      if (!r) return reply.code(409).send({ erro: 'tarefa.nao_aberta' })
      return reply.send({ ok: true })
    },
  )

  app.post<{ Params: { id: string } }>(
    '/v1/tarefas/:id/cancelar', { preHandler: exigirTenant },
    async (req, reply) => {
      const [r] = await req.comTenant((tx) => tx`
        UPDATE tarefa SET estado = 'cancelada'
         WHERE tenant_id = tenant_atual() AND id = ${req.params.id} AND estado = 'aberta' RETURNING id`)
      if (!r) return reply.code(409).send({ erro: 'tarefa.nao_aberta' })
      return reply.send({ ok: true })
    },
  )
}
