import type { FastifyInstance } from 'fastify'
import { sql, comTenantServico } from '../../db/index.js'
import { parseWebhookMeta, verificarAssinaturaMeta } from './canais/meta.js'
import { ingerirMensagemEntrante, registrarStatusMensagem } from './ingestao-mensagem.js'
import { responderAutomaticamente } from './resposta-automatica.js'

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
    for (const ev of eventos) {
      // Status/qualidade do número e status de template: por WABA, não por
      // número — tratamento próprio entra depois. Por ora, loga (200).
      if (ev.tipo === 'ignorado' || ev.tipo === 'template_status' || ev.tipo === 'qualidade') {
        if (ev.tipo !== 'ignorado') req.log.info({ tipo: ev.tipo }, 'webhook meta (adiado)')
        continue
      }

      // Roteia por phone_number_id → tenant/canal (função SECURITY DEFINER).
      const [canal] = await sql<{ tenant_id: string; canal_id: string; estado: string }[]>`
        SELECT tenant_id, canal_id, estado FROM canal_por_identificador_externo(${ev.phoneNumberId})`
      if (!canal) {
        // ⚠️ Roteamento sem alvo é falha PERMANENTE: 200 + log, senão a Meta
        //    reenvia para sempre e trava a fila de todos.
        req.log.warn({ phoneNumberId: ev.phoneNumberId }, 'webhook meta: canal não encontrado')
        continue
      }

      try {
        if (ev.tipo === 'mensagem') {
          // Fase 3: texto completo. Mídia (imagem/áudio) exige baixar pelo media
          // id + token — entra depois; por ora reconhece e segue (200).
          if (ev.conteudo.tipo !== 'texto') {
            req.log.info({ tipo: ev.conteudo.tipo }, 'webhook meta: mídia adiada')
            continue
          }
          const r = await comTenantServico(canal.tenant_id, (tx) =>
            ingerirMensagemEntrante(tx, canal.canal_id, {
              deE164: ev.de, idExterno: ev.idExterno, tipo: 'texto', texto: ev.conteudo.texto,
              nomeRemetente: ev.nomePerfil ?? undefined, recebidaEm: new Date(ev.timestamp * 1000),
            }))

          // ⚠️ Ausência e agente valem no canal OFICIAL igual: quem escreve às
          //    23h merece a mesma resposta, venha por onde vier. Faltava aqui —
          //    o produto respondia sozinho só no não-oficial, e isso só apareceria
          //    no dia em que o registro na Meta saísse.
          //
          // ⚠️ Pós-commit e best-effort: a mensagem do cliente já está salva, e
          //    erro aqui NÃO pode virar 500 — a Meta reenviaria o evento em loop,
          //    travando a fila sequencial de todos os clientes.
          //
          // ⚠️ A janela de 24h está aberta por construção: o cliente ACABOU de
          //    escrever. É o único momento em que texto livre é permitido no
          //    oficial, e é exatamente quando isto roda.
          if (r.ok && !r.duplicada) {
            try {
              const auto = await responderAutomaticamente(canal.tenant_id, r.conversaId, canal.canal_id)
              // ⚠️ Sempre, inclusive o silêncio — ver a nota no webhook do
              //    não-oficial. O motivo é o que torna a decisão auditável.
              req.log.info({ canalId: canal.canal_id, conversaId: r.conversaId, ...auto }, 'resposta automática (meta)')
            } catch (erro) {
              req.log.warn({ erro, canalId: canal.canal_id }, 'resposta automática falhou (mensagem já está salva)')
            }
          }
        } else if (ev.status === 'enviada' || ev.status === 'entregue' || ev.status === 'lida') {
          await comTenantServico(canal.tenant_id, (tx) => registrarStatusMensagem(tx, ev.idExterno, ev.status as 'enviada' | 'entregue' | 'lida'))
        }
        // status 'falhou' → tratamento (marcar mensagem falhou) entra depois.
      } catch (erro) {
        // ⚠️ Erro NOSSO (transitório, ex.: banco) → 500 para a Meta reenviar.
        req.log.error({ erro, phoneNumberId: ev.phoneNumberId }, 'webhook meta: falha ao processar')
        return reply.code(500).send({ erro: 'erro.interno' })
      }
    }
    return reply.code(200).send({ ok: true, eventos: eventos.length })
  })
}
