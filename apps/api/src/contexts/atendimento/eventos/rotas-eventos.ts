import type { FastifyInstance } from 'fastify'
import { exigirTenant } from '../../../plugins/tenant.js'
import { comTenantServico } from '../../../db/index.js'
import { assinar, type EventoCliente } from './barramento.js'

/**
 * SSE do tempo real (ADR-007). O cliente abre UMA conexão e recebe avisos
 * (sem conteúdo) de que algo mudou; então busca o dado pela API sob RLS.
 *
 * ⚠️ O tenant vem do token (exigirTenant), NUNCA de parâmetro. A conexão só
 * recebe eventos do próprio tenant — o filtro é no servidor, no `assinar`.
 *
 * ⚠️ Reconexão por CURSOR do cliente (não histórico de broker): o cliente manda
 * o último id visto em `Last-Event-ID` (ou `?desde`) e recebe o delta do outbox.
 * Assim nada se perde se a conexão cair no instante do NOTIFY.
 */
export async function rotasEventos(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { desde?: string } }>(
    '/v1/eventos',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const tenantId = req.tenantId!

      reply.hijack()
      const res = reply.raw
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // ⚠️ desliga buffering de proxies (nginx) — senão o evento fica preso.
        'x-accel-buffering': 'no',
      })
      // `retry`: se cair, o browser reconecta em 3s (e manda Last-Event-ID).
      res.write('retry: 3000\n\n')

      const enviar = (ev: EventoCliente): void => {
        res.write(`id: ${ev.id}\n`)
        res.write(`event: ${ev.tipo}\n`)
        res.write(`data: ${JSON.stringify(ev)}\n\n`)
      }

      // Replay do delta desde o último id visto (cursor no cliente).
      const bruto = req.headers['last-event-id'] ?? req.query.desde ?? '0'
      const desde = Number(Array.isArray(bruto) ? bruto[0] : bruto) || 0
      if (desde > 0) {
        try {
          const linhas = await comTenantServico(tenantId, (tx) =>
            tx<{ id: string; tipo: string; payload: { conversaId?: string; versao?: number } }[]>`
              SELECT id, tipo, payload FROM outbox
               WHERE tenant_id = tenant_atual() AND id > ${desde}
               ORDER BY id ASC LIMIT 500`)
          for (const l of linhas) {
            enviar({
              id: Number(l.id),
              tipo: l.tipo,
              ...(l.payload?.conversaId ? { conversaId: l.payload.conversaId } : {}),
              ...(l.payload?.versao !== undefined ? { versao: l.payload.versao } : {}),
            })
          }
        } catch (erro) {
          req.log.warn({ erro, tenantId }, 'replay de eventos falhou (segue ao vivo)')
        }
      }

      const desassinar = assinar(tenantId, enviar)

      // Heartbeat: mantém a conexão viva por proxies e detecta queda cedo.
      const batimento = setInterval(() => {
        try {
          res.write(': ping\n\n')
        } catch {
          // conexão morta — o 'close' abaixo limpa.
        }
      }, 25_000)

      const encerrar = (): void => {
        clearInterval(batimento)
        desassinar()
      }
      req.raw.on('close', encerrar)
      req.raw.on('error', encerrar)
    },
  )
}
