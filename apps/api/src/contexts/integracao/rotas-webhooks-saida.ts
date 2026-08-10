import { randomUUID, randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { exigirTenant } from '../../plugins/tenant.js'

/**
 * Gestão de webhooks de saída (INT-07). O despacho roda no worker; aqui é só
 * registrar/listar/remover. ⚠️ O segredo (HMAC) é mostrado UMA vez, na criação —
 * depois não devolvemos mais (não guardamos em claro para exibir; ele existe
 * para assinar, não para reexibir).
 */
export async function rotasWebhooksSaida(app: FastifyInstance): Promise<void> {
  app.get('/v1/webhooks', { preHandler: exigirTenant }, async (req, reply) => {
    const linhas = await req.comTenant((tx) => tx<{
      id: string; url: string; eventos: string[]; ativo: boolean
      entregue_em: Date | null; ultimo_erro: string | null; criado_em: Date
    }[]>`
      SELECT id, url, eventos, ativo, entregue_em, ultimo_erro, criado_em
        FROM webhook_saida WHERE tenant_id = tenant_atual() ORDER BY criado_em DESC LIMIT 100`)
    return reply.send({
      itens: linhas.map((l) => ({
        id: l.id, url: l.url, eventos: l.eventos, ativo: l.ativo,
        entregueEm: l.entregue_em, ultimoErro: l.ultimo_erro, criadoEm: l.criado_em,
      })),
    })
  })

  app.post<{ Body: { url?: string; eventos?: string[] } }>(
    '/v1/webhooks',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const url = req.body?.url?.trim()
      // ⚠️ Só HTTPS: webhook por HTTP vaza payload e assinatura em trânsito.
      if (!url || !/^https:\/\/.+/i.test(url)) {
        return reply.code(422).send({ erro: 'webhook.url_invalida', mensagem: 'Informe uma URL https válida.' })
      }
      const eventos = Array.isArray(req.body?.eventos) ? req.body!.eventos!.filter((e) => typeof e === 'string') : []
      const segredo = randomBytes(24).toString('hex')
      const id = randomUUID()

      await req.comTenant(async (tx) => {
        // Cursor no TOPO atual: o webhook novo recebe do PRÓXIMO evento em diante,
        // nunca o histórico inteiro.
        const [topo] = await tx<{ max: string }[]>`
          SELECT coalesce(max(id), 0)::text AS max FROM outbox WHERE tenant_id = tenant_atual()`
        await tx`
          INSERT INTO webhook_saida (tenant_id, id, url, eventos, segredo, cursor)
          VALUES (tenant_atual(), ${id}, ${url}, ${eventos}, ${segredo}, ${topo?.max ?? '0'})`
      })
      // ⚠️ Segredo devolvido AQUI e só aqui.
      return reply.code(201).send({ id, segredo, eventos })
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/v1/webhooks/:id',
    { preHandler: exigirTenant },
    async (req, reply) => {
      await req.comTenant((tx) => tx`
        DELETE FROM webhook_saida WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`)
      return reply.send({ ok: true })
    },
  )
}
