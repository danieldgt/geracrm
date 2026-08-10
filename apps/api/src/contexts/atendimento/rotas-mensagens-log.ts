import type { FastifyInstance } from 'fastify'
import { exigirTenant } from '../../plugins/tenant.js'

const PAGINA = 30
const STATUS_FILTRO = new Set(['pendente', 'enviada', 'entregue', 'lida', 'falhou'])

/**
 * Mensagens Enviadas — log das mensagens salientes (quem, para quem, quando,
 * status). ⚠️ Preview só de TEXTO, extraído no servidor; mídia nunca trafega o
 * blob aqui (o log mostra "[imagem]"/"[áudio]"). Cursor por (criado_em, id) desc.
 * Tenant sempre de tenant_atual() (ADR-001).
 */
export async function rotasMensagensLog(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { status?: string; cursor?: string } }>(
    '/v1/mensagens-enviadas', { preHandler: exigirTenant },
    async (req, reply) => {
      const status = STATUS_FILTRO.has(req.query.status ?? '') ? req.query.status! : null
      let curEm: string | null = null, curId: string | null = null
      if (req.query.cursor) {
        const [em, id] = Buffer.from(req.query.cursor, 'base64url').toString('utf8').split('§')
        if (!em || !id) return reply.code(422).send({ erro: 'cursor.invalido' })
        curEm = em; curId = id
      }
      const linhas = await req.comTenant((tx) => tx<{
        id: string; criado_em: Date; tipo: string; status: string | null; preview: string | null
        contato_id: string | null; contato: string | null; enviada_por: string | null
      }[]>`
        SELECT m.id, m.criado_em, m.tipo, m.status,
               CASE WHEN m.tipo = 'texto' THEN left(m.conteudo->>'texto', 140) ELSE NULL END AS preview,
               cv.contato_id, ct.nome AS contato, u.nome AS enviada_por
          FROM mensagem m
          JOIN conversa cv ON cv.tenant_id = m.tenant_id AND cv.id = m.conversa_id
          LEFT JOIN contato ct ON ct.tenant_id = cv.tenant_id AND ct.id = cv.contato_id
          LEFT JOIN usuario u  ON u.tenant_id = m.tenant_id AND u.id = m.enviada_por_id
         WHERE m.tenant_id = tenant_atual() AND m.direcao = 'saliente'
           AND ${status === null ? tx`true` : tx`m.status = ${status}`}
           AND ${curEm === null ? tx`true` : tx`(m.criado_em, m.id) < (${curEm}::timestamptz, ${curId}::uuid)`}
         ORDER BY m.criado_em DESC, m.id DESC LIMIT ${PAGINA + 1}`)

      const temMais = linhas.length > PAGINA
      const pagina = temMais ? linhas.slice(0, PAGINA) : linhas
      const ultimo = pagina[pagina.length - 1]
      return reply.send({
        itens: pagina.map((l) => ({
          id: l.id, criadoEm: l.criado_em, tipo: l.tipo, status: l.status,
          preview: l.tipo === 'texto' ? (l.preview ?? '') : l.tipo === 'imagem' ? '[imagem]' : l.tipo === 'audio' ? '[áudio]' : `[${l.tipo}]`,
          contatoId: l.contato_id, contato: l.contato, enviadaPor: l.enviada_por,
        })),
        proximoCursor: temMais && ultimo
          ? Buffer.from(`${ultimo.criado_em.toISOString()}§${ultimo.id}`).toString('base64url') : null,
      })
    },
  )
}
