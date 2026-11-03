import type { FastifyInstance } from 'fastify'
import { previewMensagem } from '@geracrm/shared'
import { exigirTenant } from '../../plugins/tenant.js'
import { exigirNoEscopo } from '../plataforma/escopo.js'
import { lerCursorFeed, lerFeedDoContato } from './contato-feed.js'

const PAGINA = 30
const MENSAGENS_RESUMO = 6
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Feed do contato: linha do tempo cronológica (mais novo primeiro), por cursor. Ver `contato-feed.ts`. */
export async function rotasContatoFeed(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string }; Querystring: { cursor?: string } }>(
    '/v1/contatos/:id/feed', { preHandler: [exigirTenant, exigirNoEscopo('contato')] },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'contato.nao_encontrado' })
      const cursor = lerCursorFeed(req.query.cursor)
      if (cursor === 'invalido') return reply.code(422).send({ erro: 'cursor.invalido' })
      const r = await req.comTenant(async (tx) => {
        const [c] = await tx`SELECT 1 FROM contato WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        if (!c) return null
        return lerFeedDoContato(tx, req.params.id, { cursor, limite: PAGINA })
      })
      if (!r) return reply.code(404).send({ erro: 'contato.nao_encontrado' })
      return reply.send(r)
    },
  )

  /**
   * Aba WhatsApp da ficha: a conversa mais recente do contato e as últimas mensagens RESUMIDAS
   * (uma linha, truncada). Não abre nem cria conversa — quem quer conversar usa `POST /v1/conversas`.
   * É leitura do mesmo dado que o chat já mostra a quem tem acesso; fica fora do feed de propósito.
   */
  app.get<{ Params: { id: string } }>(
    '/v1/contatos/:id/whatsapp', { preHandler: [exigirTenant, exigirNoEscopo('contato')] },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'contato.nao_encontrado' })
      const r = await req.comTenant(async (tx) => {
        const [c] = await tx`SELECT 1 FROM contato WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        if (!c) return null
        const [conversa] = await tx<{ id: string; canal: string; ultima_mensagem_em: Date | null }[]>`
          SELECT cv.id, ca.nome_amigavel AS canal, cv.ultima_mensagem_em
            FROM conversa cv JOIN canal_conectado ca ON ca.tenant_id = cv.tenant_id AND ca.id = cv.canal_id
           WHERE cv.tenant_id = tenant_atual() AND cv.contato_id = ${req.params.id}
           ORDER BY cv.ultima_mensagem_em DESC NULLS LAST, cv.id DESC LIMIT 1`
        if (!conversa) return { conversa: null, mensagens: [] }
        const msgs = await tx<{ id: string; direcao: string; tipo: string; conteudo: unknown; criado_em: Date }[]>`
          SELECT id, direcao, tipo, conteudo, criado_em FROM mensagem
           WHERE tenant_id = tenant_atual() AND conversa_id = ${conversa.id} AND tipo <> 'sistema'
           ORDER BY criado_em DESC, id DESC LIMIT ${MENSAGENS_RESUMO}`
        return { conversa, mensagens: msgs }
      })
      if (!r) return reply.code(404).send({ erro: 'contato.nao_encontrado' })
      return reply.send({
        conversa: r.conversa ? { id: r.conversa.id, canal: r.conversa.canal, ultimaMensagemEm: r.conversa.ultima_mensagem_em } : null,
        mensagens: r.mensagens.map((m) => ({
          id: m.id, direcao: m.direcao, tipo: m.tipo, criadoEm: m.criado_em,
          resumo: previewMensagem(m.tipo, m.conteudo).slice(0, 140),
        })),
      })
    },
  )
}
