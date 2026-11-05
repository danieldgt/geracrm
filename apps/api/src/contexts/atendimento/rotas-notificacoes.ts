import type { FastifyInstance } from 'fastify'
import { exigirTenant } from '../../plugins/tenant.js'
import { atorDaRequisicao } from './rotas-fila.js'

const PAGINA = 30
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
  app.get<{ Querystring: { cursor?: string; lida?: string; tipo?: string } }>(
    '/v1/notificacoes',
    { preHandler: exigirTenant },
    async (req, reply) => {
      // D4: filtros da página Notificações. Valor desconhecido é 422, nunca filtro ignorado em silêncio.
      const { lida, tipo } = req.query
      if (lida !== undefined && lida !== 'sim' && lida !== 'nao') {
        return reply.code(422).send({ erro: 'notificacao.filtro_invalido', mensagem: 'O filtro "lida" aceita sim ou nao.', campos: ['lida'] })
      }
      if (tipo !== undefined && !/^[a-z_]+(\.[a-z_]+)?$/.test(tipo)) {
        return reply.code(422).send({ erro: 'notificacao.filtro_invalido', mensagem: 'Tipo inválido.', campos: ['tipo'] })
      }
      let cursorEm: string | null = null
      let cursorId: string | null = null
      if (req.query.cursor) {
        const [em, id] = Buffer.from(req.query.cursor, 'base64url').toString('utf8').split('§')
        if (!em || !id || !UUID.test(id) || Number.isNaN(Date.parse(em))) return reply.code(422).send({ erro: 'cursor.invalido', mensagem: 'Cursor inválido.' })
        cursorEm = em
        cursorId = id
      }

      const r = await req.comTenant(async (tx) => {
        const eu = await atorDaRequisicao(tx, req)
        const linhas = await tx<{
          id: string; tipo: string; titulo: string; conversa_id: string | null
          lida_em: Date | null; criado_em: Date; em_txt: string
        }[]>`
          SELECT id, tipo, titulo, conversa_id, lida_em, criado_em,
                 to_char(criado_em AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS em_txt
            FROM notificacao
           WHERE tenant_id = tenant_atual() AND usuario_id = ${eu} AND no_app
             AND ${lida === undefined ? tx`true` : lida === 'sim' ? tx`lida_em IS NOT NULL` : tx`lida_em IS NULL`}
             AND ${tipo === undefined ? tx`true` : tx`tipo = ${tipo}`}
             AND ${cursorEm === null ? tx`true` : tx`
                   (criado_em, id) < (${cursorEm}::text::timestamptz, ${cursorId}::uuid)`}
           ORDER BY criado_em DESC, id DESC
           LIMIT ${PAGINA + 1}`
        return linhas
      })

      const temMais = r.length > PAGINA
      const pagina = temMais ? r.slice(0, PAGINA) : r
      const ultimo = pagina[pagina.length - 1]
      const proximoCursor = temMais && ultimo
        ? Buffer.from(`${ultimo.em_txt}§${ultimo.id}`).toString('base64url')
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
      const eu = await atorDaRequisicao(tx, req)
      const [c] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM notificacao
         WHERE tenant_id = tenant_atual() AND usuario_id = ${eu} AND lida_em IS NULL AND no_app`
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
        const eu = await atorDaRequisicao(tx, req)
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
