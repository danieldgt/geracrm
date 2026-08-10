import type { FastifyInstance } from 'fastify'
import { normalizarTelefone } from '@geracrm/shared'
import { exigirTenant } from '../../plugins/tenant.js'

const PAGINA = 30
const MOTIVOS = new Set(['opt_out', 'denuncia', 'manual', 'invalido'])

/**
 * Gestão de opt-out / bloqueio (EP-04). ⚠️ A `lista_bloqueio` já é respeitada no
 * servidor pelo gateway de envio (E5-13) — esta rota é só para GERIR a lista.
 *
 * ⚠️ Bloqueio é por `chave_bloqueio` (55+DDD+8 últimos, INV-50), não por e164 —
 * vale com e sem o nono dígito. A tela manda um telefone; nós derivamos a chave.
 */
export async function rotasBloqueios(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { cursor?: string } }>(
    '/v1/bloqueios',
    { preHandler: exigirTenant },
    async (req, reply) => {
      let cursorEm: string | null = null
      let cursorChave: string | null = null
      if (req.query.cursor) {
        const [em, ch] = Buffer.from(req.query.cursor, 'base64url').toString('utf8').split('§')
        if (!em || !ch) return reply.code(422).send({ erro: 'cursor.invalido', mensagem: 'Cursor inválido.' })
        cursorEm = em; cursorChave = ch
      }
      const linhas = await req.comTenant((tx) => tx<{
        chave_bloqueio: string; motivo: string; origem: string | null; bloqueado_em: Date
      }[]>`
        SELECT chave_bloqueio, motivo, origem, bloqueado_em
          FROM lista_bloqueio
         WHERE tenant_id = tenant_atual()
           AND ${cursorEm === null ? tx`true` : tx`
                 (bloqueado_em, chave_bloqueio) < (${cursorEm}::timestamptz, ${cursorChave})`}
         ORDER BY bloqueado_em DESC, chave_bloqueio DESC
         LIMIT ${PAGINA + 1}`)

      const temMais = linhas.length > PAGINA
      const pagina = temMais ? linhas.slice(0, PAGINA) : linhas
      const ultimo = pagina[pagina.length - 1]
      const proximoCursor = temMais && ultimo
        ? Buffer.from(`${ultimo.bloqueado_em.toISOString()}§${ultimo.chave_bloqueio}`).toString('base64url')
        : null

      return reply.send({
        itens: pagina.map((l) => ({
          chave: l.chave_bloqueio, motivo: l.motivo, origem: l.origem, bloqueadoEm: l.bloqueado_em,
        })),
        proximoCursor,
      })
    },
  )

  /** Bloqueia um telefone (opt-out manual pela tela). Idempotente. */
  app.post<{ Body: { telefone?: string; motivo?: string } }>(
    '/v1/bloqueios',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const tel = normalizarTelefone(req.body?.telefone ?? '')
      if (!tel) return reply.code(422).send({ erro: 'telefone.invalido', mensagem: 'Telefone inválido.' })
      const motivo = MOTIVOS.has(req.body?.motivo ?? '') ? req.body!.motivo! : 'opt_out'

      await req.comTenant((tx) => tx`
        INSERT INTO lista_bloqueio (tenant_id, chave_bloqueio, motivo, origem)
        VALUES (tenant_atual(), ${tel.chaveBloqueio}, ${motivo}, 'console')
        ON CONFLICT (tenant_id, chave_bloqueio) DO NOTHING`)
      return reply.code(201).send({ ok: true, chave: tel.chaveBloqueio })
    },
  )

  /** Remove o bloqueio (desfaz o opt-out). */
  app.delete<{ Params: { chave: string } }>(
    '/v1/bloqueios/:chave',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const chave = req.params.chave
      if (!/^\d{10,13}$/.test(chave)) return reply.code(422).send({ erro: 'chave.invalida' })
      await req.comTenant((tx) => tx`
        DELETE FROM lista_bloqueio WHERE tenant_id = tenant_atual() AND chave_bloqueio = ${chave}`)
      return reply.send({ ok: true })
    },
  )
}
