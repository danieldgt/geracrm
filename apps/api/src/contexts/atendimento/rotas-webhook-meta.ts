import type { FastifyInstance } from 'fastify'
import { parseWebhookMeta, verificarAssinaturaMeta } from './canais/meta.js'

/**
 * Webhook da Meta (WhatsApp Cloud API / Instagram Direct).
 *
 * ⚠️ PÚBLICO e sem o nosso JWT — a Meta chama direto. A autenticidade vem da
 * ASSINATURA (`X-Hub-Signature-256` = HMAC-SHA256 do corpo cru com o App Secret),
 * não de token de sessão. Por isso este plugin tem parser de BUFFER próprio
 * (encapsulado): a assinatura precisa do corpo exatamente como veio.
 *
 * ⚠️ O código HTTP é INSTRUÇÃO (skill geracrm-whatsapp-meta): 2xx encerra; erro
 * faz a Meta reenviar. Assinatura inválida → 401 (não é evento da Meta, é ruído;
 * a Meta legítima sempre assina, então não entra em loop). Evento reconhecido →
 * sempre 200. O gateway só valida/registra; processar fica para worker.
 */
export async function rotasWebhookMeta(app: FastifyInstance): Promise<void> {
  // Parser de buffer SÓ neste escopo — mantém o corpo cru para o HMAC e ainda
  // entrega o JSON já parseado ao handler. O resto da API segue no parser padrão.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    const buf = body as Buffer
    ;(_req as unknown as { rawBody?: Buffer }).rawBody = buf
    try { done(null, buf.length ? JSON.parse(buf.toString('utf8')) : {}) }
    catch (e) { done(e as Error, undefined) }
  })

  // Handshake de verificação (Meta chama ao configurar o callback no painel).
  app.get('/webhooks/meta', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>
    const token = process.env.META_VERIFY_TOKEN
    if (q['hub.mode'] === 'subscribe' && token && q['hub.verify_token'] === token) {
      // ⚠️ Devolve o challenge em texto puro — a Meta compara byte a byte.
      return reply.type('text/plain').send(q['hub.challenge'] ?? '')
    }
    return reply.code(403).send({ erro: 'verify.falhou' })
  })

  // Recebimento de eventos (mensagem, status, qualidade, status de template).
  app.post('/webhooks/meta', async (req, reply) => {
    const secret = process.env.META_APP_SECRET
    if (!secret) {
      // Sem segredo não dá para verificar autenticidade — recusa e avisa no log.
      req.log.error('META_APP_SECRET ausente — webhook Meta recusado')
      return reply.code(401).send({ erro: 'nao_configurado' })
    }
    const raw = (req as unknown as { rawBody?: Buffer }).rawBody
    const assinatura = req.headers['x-hub-signature-256'] as string | undefined
    if (!raw || !verificarAssinaturaMeta(raw, assinatura, secret)) {
      return reply.code(401).send({ erro: 'assinatura_invalida' })
    }

    const eventos = parseWebhookMeta(req.body)
    // Fase 1: valida + reconhece + loga. A ingestão nas conversas entra quando
    // houver WABA onboardada (mapeamento phone_number_id → canal). Sempre 200.
    for (const ev of eventos) {
      if (ev.tipo !== 'ignorado') req.log.info({ tipo: ev.tipo }, 'webhook meta recebido')
    }
    return reply.code(200).send({ ok: true, eventos: eventos.length })
  })
}
