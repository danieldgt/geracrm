import type { FastifyInstance } from 'fastify'
import { exigirTenant } from '../../../../plugins/tenant.js'
import { listarMemoria, revogarMemoria } from './memoria.js'

/**
 * A memória do cliente na tela do contato: o vendedor vê o que o agente
 * aprendeu e revoga o que estiver errado ou envelheceu. Nada se cria por aqui
 * — memória nasce da conversa (ferramenta `memoria_anotar`), nunca de formulário.
 */

const PAGINA = 20
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function rotasMemoria(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string }; Querystring: { cursor?: string } }>(
    '/v1/contatos/:id/memoria', { preHandler: exigirTenant },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'contato.nao_encontrado' })
      let cursor: { criadoEm: string; id: string } | null = null
      if (req.query.cursor) {
        const [em, id] = Buffer.from(req.query.cursor, 'base64url').toString('utf8').split('§')
        if (!em || !id || !UUID.test(id)) return reply.code(422).send({ erro: 'cursor.invalido' })
        cursor = { criadoEm: em, id }
      }
      const r = await req.comTenant(async (tx) => {
        const [contato] = await tx<{ id: string }[]>`SELECT id FROM contato WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        if (!contato) return null
        return listarMemoria(tx, req.params.id, { cursor, limite: PAGINA })
      })
      if (!r) return reply.code(404).send({ erro: 'contato.nao_encontrado' })
      return reply.send({
        itens: r.itens,
        proximoCursor: r.proximoCursor ? Buffer.from(`${r.proximoCursor.criadoEm}§${r.proximoCursor.id}`).toString('base64url') : null,
      })
    },
  )

  app.delete<{ Params: { id: string; memoriaId: string } }>(
    '/v1/contatos/:id/memoria/:memoriaId', { preHandler: exigirTenant },
    async (req, reply) => {
      if (!UUID.test(req.params.id) || !UUID.test(req.params.memoriaId)) return reply.code(404).send({ erro: 'memoria.nao_encontrada' })
      const revogada = await req.comTenant(async (tx) => {
        // A memória tem de ser DESTE contato — o id da URL não é decorativo.
        const [m] = await tx<{ id: string }[]>`
          SELECT id FROM cliente_memoria
           WHERE tenant_id = tenant_atual() AND id = ${req.params.memoriaId} AND contato_id = ${req.params.id}`
        if (!m) return false
        return revogarMemoria(tx, m.id)
      })
      if (!revogada) return reply.code(404).send({ erro: 'memoria.nao_encontrada' })
      return reply.send({ ok: true })
    },
  )
}
