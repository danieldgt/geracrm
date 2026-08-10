import type { FastifyInstance } from 'fastify'
import { exigirTenant } from '../../plugins/tenant.js'
import { garantirUsuarioId } from './rotas-fila.js'

const PAGINA = 30

/**
 * Notificações pessoais (PLT-07) — o sino.
 *
 * ⚠️ SEMPRE do usuário autenticado: o `usuario_id` sai do token (via
 * `garantirUsuarioId`), nunca de parâmetro. RLS isola por tenant; o filtro por
 * usuário é o que impede um atendente de ler o sino do outro.
 *
 * ⚠️ Lista paginada por CURSOR `(criado_em, id)` — nunca top-N cru (CLAUDE.md).
 */
export async function rotasNotificacoes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { cursor?: string } }>(
    '/v1/notificacoes',
    { preHandler: exigirTenant },
    async (req, reply) => {
      let cursorEm: string | null = null
      let cursorId: string | null = null
      if (req.query.cursor) {
        const [em, id] = Buffer.from(req.query.cursor, 'base64url').toString('utf8').split('§')
        if (!em || !id) return reply.code(422).send({ erro: 'cursor.invalido', mensagem: 'Cursor inválido.' })
        cursorEm = em
        cursorId = id
      }

      const r = await req.comTenant(async (tx) => {
        const eu = await garantirUsuarioId(tx, req)
        const linhas = await tx<{
          id: string; tipo: string; titulo: string; conversa_id: string | null
          lida_em: Date | null; criado_em: Date
        }[]>`
          SELECT id, tipo, titulo, conversa_id, lida_em, criado_em
            FROM notificacao
           WHERE tenant_id = tenant_atual() AND usuario_id = ${eu}
             AND ${cursorEm === null ? tx`true` : tx`
                   (criado_em, id) < (${cursorEm}::timestamptz, ${cursorId}::uuid)`}
           ORDER BY criado_em DESC, id DESC
           LIMIT ${PAGINA + 1}`
        return linhas
      })

      const temMais = r.length > PAGINA
      const pagina = temMais ? r.slice(0, PAGINA) : r
      const ultimo = pagina[pagina.length - 1]
      const proximoCursor = temMais && ultimo
        ? Buffer.from(`${ultimo.criado_em.toISOString()}§${ultimo.id}`).toString('base64url')
        : null

      return reply.send({
        itens: pagina.map((l) => ({
          id: l.id, tipo: l.tipo, titulo: l.titulo, conversaId: l.conversa_id,
          lida: l.lida_em !== null, criadoEm: l.criado_em,
        })),
        proximoCursor,
      })
    },
  )

  /** Contador de não-lidas — a bolinha do sino. */
  app.get('/v1/notificacoes/contador', { preHandler: exigirTenant }, async (req, reply) => {
    const total = await req.comTenant(async (tx) => {
      const eu = await garantirUsuarioId(tx, req)
      const [c] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM notificacao
         WHERE tenant_id = tenant_atual() AND usuario_id = ${eu} AND lida_em IS NULL`
      return c?.n ?? 0
    })
    return reply.send({ naoLidas: total })
  })

  /**
   * Marca lidas. Sem `ids` → marca TODAS as não-lidas (o "limpar o sino"). Com
   * `ids` → só aquelas (ex.: ao abrir a conversa da notificação).
   */
  app.post<{ Body: { ids?: string[] } }>(
    '/v1/notificacoes/lidas',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const ids = req.body?.ids
      const marcadas = await req.comTenant(async (tx) => {
        const eu = await garantirUsuarioId(tx, req)
        const linhas = await tx<{ id: string }[]>`
          UPDATE notificacao SET lida_em = now()
           WHERE tenant_id = tenant_atual() AND usuario_id = ${eu} AND lida_em IS NULL
             AND ${ids && ids.length ? tx`id = ANY(${ids}::uuid[])` : tx`true`}
           RETURNING id`
        return linhas.length
      })
      return reply.send({ ok: true, marcadas })
    },
  )
}
