import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { exigirTenant } from '../../plugins/tenant.js'
import { audienciaDoSegmento, roiCampanha } from './campanha-analise.js'

const PAGINA = 30

/**
 * Campanhas com ROI (Onda 3). ⚠️ O disparo ENFILEIRA os envios (respeitando o
 * gateway de envio depois); não sai mandando em massa daqui. O ROI separa a
 * atribuição exata da estimada.
 */
export async function rotasCampanha(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { cursor?: string } }>(
    '/v1/campanhas', { preHandler: exigirTenant },
    async (req, reply) => {
      let curEm: string | null = null, curId: string | null = null
      if (req.query.cursor) {
        const [em, id] = Buffer.from(req.query.cursor, 'base64url').toString('utf8').split('§')
        if (!em || !id) return reply.code(422).send({ erro: 'cursor.invalido' })
        curEm = em; curId = id
      }
      const linhas = await req.comTenant((tx) => tx<{
        id: string; nome: string; segmento_alvo: string; estado: string
        janela_atribuicao_dias: number; disparada_em: Date | null; criado_em: Date
      }[]>`
        SELECT id, nome, segmento_alvo, estado, janela_atribuicao_dias, disparada_em, criado_em
          FROM campanha WHERE tenant_id = tenant_atual()
           AND ${curEm === null ? tx`true` : tx`(criado_em, id) < (${curEm}::timestamptz, ${curId}::uuid)`}
         ORDER BY criado_em DESC, id DESC LIMIT ${PAGINA + 1}`)
      const temMais = linhas.length > PAGINA
      const pagina = temMais ? linhas.slice(0, PAGINA) : linhas
      const ultimo = pagina[pagina.length - 1]
      return reply.send({
        itens: pagina.map((l) => ({
          id: l.id, nome: l.nome, segmentoAlvo: l.segmento_alvo, estado: l.estado,
          janelaDias: l.janela_atribuicao_dias, disparadaEm: l.disparada_em, criadoEm: l.criado_em,
        })),
        proximoCursor: temMais && ultimo
          ? Buffer.from(`${ultimo.criado_em.toISOString()}§${ultimo.id}`).toString('base64url') : null,
      })
    },
  )

  app.post<{ Body: { nome?: string; segmentoAlvo?: string; mensagem?: string; janelaDias?: number } }>(
    '/v1/campanhas', { preHandler: exigirTenant },
    async (req, reply) => {
      const nome = req.body?.nome?.trim()
      const mensagem = req.body?.mensagem?.trim()
      if (!nome || !mensagem) return reply.code(422).send({ erro: 'campanha.invalida', mensagem: 'Nome e mensagem são obrigatórios.' })
      const janela = Math.min(Math.max(Number(req.body?.janelaDias) || 7, 1), 90)
      const id = randomUUID()
      await req.comTenant((tx) => tx`
        INSERT INTO campanha (tenant_id, id, nome, segmento_alvo, mensagem, janela_atribuicao_dias)
        VALUES (tenant_atual(), ${id}, ${nome}, ${req.body?.segmentoAlvo ?? 'todos'}, ${mensagem}, ${janela})`)
      return reply.code(201).send({ id })
    },
  )

  /** Prévia da audiência — quantos contatos o segmento alcança. */
  app.get<{ Params: { id: string } }>(
    '/v1/campanhas/:id/audiencia', { preHandler: exigirTenant },
    async (req, reply) => {
      const total = await req.comTenant(async (tx) => {
        const [c] = await tx<{ segmento_alvo: string }[]>`
          SELECT segmento_alvo FROM campanha WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        if (!c) return null
        return (await audienciaDoSegmento(tx, c.segmento_alvo)).length
      })
      if (total === null) return reply.code(404).send({ erro: 'campanha.nao_encontrada' })
      return reply.send({ total })
    },
  )

  /**
   * Dispara: enfileira UM envio por destinatário do segmento (idempotente).
   * ⚠️ O envio real sai pelo gateway (opt-out/janela) num passo seguinte — aqui
   * só monta a fila e marca a campanha como disparando.
   */
  app.post<{ Params: { id: string } }>(
    '/v1/campanhas/:id/disparar', { preHandler: exigirTenant },
    async (req, reply) => {
      const r = await req.comTenant(async (tx) => {
        const [c] = await tx<{ segmento_alvo: string; estado: string }[]>`
          SELECT segmento_alvo, estado FROM campanha WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        if (!c) return { erro: 'nao_encontrada' as const }
        if (c.estado !== 'rascunho') return { erro: 'ja_disparada' as const }

        const alvo = await audienciaDoSegmento(tx, c.segmento_alvo)
        for (const contatoId of alvo) {
          await tx`INSERT INTO campanha_envio (tenant_id, id, campanha_id, contato_id)
                   VALUES (tenant_atual(), ${randomUUID()}, ${req.params.id}, ${contatoId})
                   ON CONFLICT (tenant_id, campanha_id, contato_id) DO NOTHING`
        }
        await tx`UPDATE campanha SET estado = 'disparando', disparada_em = now()
                  WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        return { enfileirados: alvo.length }
      })
      if ('erro' in r) {
        return reply.code(r.erro === 'nao_encontrada' ? 404 : 409).send({ erro: `campanha.${r.erro}` })
      }
      return reply.send({ ok: true, enfileirados: r.enfileirados })
    },
  )

  /** ROI — atribuição exata e estimada, SEPARADAS. */
  app.get<{ Params: { id: string } }>(
    '/v1/campanhas/:id/roi', { preHandler: exigirTenant },
    async (req, reply) => {
      const roi = await req.comTenant((tx) => roiCampanha(tx, req.params.id))
      if (!roi) return reply.code(404).send({ erro: 'campanha.nao_encontrada' })
      return reply.send(roi)
    },
  )
}
