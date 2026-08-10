import type { FastifyInstance } from 'fastify'
import { exigirTenant } from '../../plugins/tenant.js'

const PAGINA = 50

/**
 * Leitura do rastro de auditoria (EP-07 / PLT-05).
 *
 * ⚠️ Paginado por CURSOR, nunca top-N cru (CLAUDE.md). O rastro só cresce — uma
 * conta antiga tem centenas de milhares de linhas. Cursor `(criado_em, id)` para
 * trás, que é exatamente a ordem da PK particionada `(tenant_id, criado_em, id)`,
 * então a paginação não faz sort nem OFFSET profundo.
 */
export async function rotasAuditoria(app: FastifyInstance): Promise<void> {
  app.get('/v1/auditoria', { preHandler: exigirTenant }, async (req, reply) => {
    const q = (req.query ?? {}) as { cursor?: string; entidadeId?: string }

    let cursorEm: string | null = null
    let cursorId: string | null = null
    if (q.cursor) {
      const [em, id] = Buffer.from(q.cursor, 'base64url').toString('utf8').split('§')
      if (!em || !id) return reply.code(422).send({ erro: 'cursor.invalido', mensagem: 'Cursor inválido.' })
      cursorEm = em
      cursorId = id
    }

    // Pede uma linha a mais para saber se há próxima página sem um count separado.
    const linhas = await req.comTenant((tx) => tx<{
      id: string; criado_em: Date; acao: string; entidade: string; entidade_id: string | null
      dados: unknown; ator_nome: string | null
    }[]>`
      SELECT a.id, a.criado_em, a.acao, a.entidade, a.entidade_id, a.dados, u.nome AS ator_nome
        FROM auditoria a
        LEFT JOIN usuario u ON u.tenant_id = a.tenant_id AND u.id = a.ator_id
       WHERE a.tenant_id = tenant_atual()
         AND ${q.entidadeId ? tx`a.entidade_id = ${q.entidadeId}` : tx`true`}
         AND ${cursorEm === null ? tx`true` : tx`
               (a.criado_em, a.id) < (${cursorEm}::timestamptz, ${cursorId}::uuid)`}
       ORDER BY a.criado_em DESC, a.id DESC
       LIMIT ${PAGINA + 1}`)

    const temMais = linhas.length > PAGINA
    const pagina = temMais ? linhas.slice(0, PAGINA) : linhas
    const ultimo = pagina[pagina.length - 1]
    const proximoCursor = temMais && ultimo
      ? Buffer.from(`${ultimo.criado_em.toISOString()}§${ultimo.id}`).toString('base64url')
      : null

    return reply.send({
      itens: pagina.map((l) => ({
        criadoEm: l.criado_em, acao: l.acao, entidade: l.entidade,
        entidadeId: l.entidade_id, atorNome: l.ator_nome, dados: l.dados,
      })),
      proximoCursor,
    })
  })
}
