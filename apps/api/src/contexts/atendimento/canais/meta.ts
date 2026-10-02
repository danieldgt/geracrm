import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Canal Meta (WhatsApp Cloud API / Instagram) — parsing de webhook e verificação
 * de assinatura. PURO e sem I/O: a rota valida, este módulo interpreta.
 *
 * ⚠️ A Meta é SEMPRE mockada por contrato nos testes (fixtures reais). Nunca
 * chamar a Graph API em teste (skill geracrm-whatsapp-meta / geracrm-testes).
 */

/** Verifica `X-Hub-Signature-256: sha256=<hex>` (HMAC-SHA256 do corpo CRU). */
export function verificarAssinaturaMeta(corpoCru: Buffer, cabecalho: string | undefined, appSecret: string): boolean {
  if (!cabecalho || !cabecalho.startsWith('sha256=')) return false
  const esperado = createHmac('sha256', appSecret).update(corpoCru).digest('hex')
  const recebido = cabecalho.slice('sha256='.length)
  // Comparação em tempo constante — length-mismatch também não vaza timing.
  const a = Buffer.from(esperado, 'hex')
  const b = Buffer.from(recebido, 'hex')
  if (a.length !== b.length || a.length === 0) return false
  return timingSafeEqual(a, b)
}

/**
 * O conteúdo de uma mensagem entrante, já no NOSSO vocabulário:
 * - `texto`: corpo (inclui resposta de botão — o título vira texto, e o `id`
 *   do botão viaja em `botaoId` para quem quiser decidir por ele);
 * - `imagem`/`audio`: a Meta NÃO manda URL, manda `media id`; baixar é outro
 *   passo, com o token, fora do webhook (`PortaCanal.baixarMidia`);
 * - outro: tipo cru da Meta (video, document, sticker, location…), ainda não
 *   ingerido — reconhecido e logado, nunca jogado fora em silêncio.
 */
export type ConteudoMeta =
  | { tipo: 'texto'; texto: string; botaoId?: string }
  | { tipo: 'imagem'; midiaId: string; mime: string | null; legenda: string | null }
  | { tipo: 'audio'; midiaId: string; mime: string | null }
  | { tipo: 'outro'; tipoCru: string }

export type EventoMeta =
  | { tipo: 'mensagem'; phoneNumberId: string; de: string; idExterno: string; timestamp: number
      conteudo: ConteudoMeta; nomePerfil: string | null }
  | { tipo: 'status'; phoneNumberId: string; idExterno: string; status: string; timestamp: number }
  | { tipo: 'template_status'; wabaId: string; nome: string; idioma: string | null; status: string; motivo: string | null }
  | { tipo: 'qualidade'; phoneNumberId: string | null; evento: string; detalhe: string | null }
  | { tipo: 'ignorado'; motivo: string }

// Mapa dos status do WhatsApp Cloud para o nosso vocabulário de mensagem.
const STATUS_META: Record<string, string> = {
  sent: 'enviada', delivered: 'entregue', read: 'lida', failed: 'falhou',
}

/**
 * Normaliza um webhook da Meta (um payload pode carregar VÁRIOS eventos). Cobre
 * WhatsApp: mensagem entrante, status de entrega, qualidade do número, e status
 * de template. O que não reconhecemos vira `ignorado` (com motivo) — nunca joga
 * fora em silêncio.
 */
export function parseWebhookMeta(corpo: unknown): EventoMeta[] {
  const b = corpo as { object?: string; entry?: unknown[] }
  if (!b || typeof b !== 'object' || !Array.isArray(b.entry)) return [{ tipo: 'ignorado', motivo: 'sem_entry' }]

  const eventos: EventoMeta[] = []
  for (const entryRaw of b.entry) {
    const entry = entryRaw as { id?: string; changes?: unknown[] }
    const wabaId = entry.id ?? ''
    for (const chRaw of entry.changes ?? []) {
      const ch = chRaw as { field?: string; value?: Record<string, unknown> }
      const v = ch.value ?? {}
      const phoneNumberId = ((v.metadata as { phone_number_id?: string } | undefined)?.phone_number_id) ?? null

      if (ch.field === 'messages') {
        const nome = ((v.contacts as { profile?: { name?: string } }[] | undefined)?.[0]?.profile?.name) ?? null
        for (const mRaw of (v.messages as unknown[] | undefined) ?? []) {
          const m = mRaw as { from?: string; id?: string; timestamp?: string; type?: string }
          if (!m.from || !m.id || !phoneNumberId) { eventos.push({ tipo: 'ignorado', motivo: 'mensagem_incompleta' }); continue }
          eventos.push({
            tipo: 'mensagem', phoneNumberId, de: m.from, idExterno: m.id,
            timestamp: Number(m.timestamp ?? 0),
            conteudo: conteudoDaMensagemMeta(mRaw),
            nomePerfil: nome,
          })
        }
        for (const sRaw of (v.statuses as unknown[] | undefined) ?? []) {
          const s = sRaw as { id?: string; status?: string; timestamp?: string }
          if (!s.id || !s.status || !phoneNumberId) { eventos.push({ tipo: 'ignorado', motivo: 'status_incompleto' }); continue }
          eventos.push({
            tipo: 'status', phoneNumberId, idExterno: s.id,
            status: STATUS_META[s.status] ?? s.status, timestamp: Number(s.timestamp ?? 0),
          })
        }
        if (!(v.messages as unknown[] | undefined)?.length && !(v.statuses as unknown[] | undefined)?.length) {
          eventos.push({ tipo: 'ignorado', motivo: 'messages_sem_conteudo' })
        }
      } else if (ch.field === 'message_template_status_update') {
        eventos.push({
          tipo: 'template_status', wabaId,
          nome: (v.message_template_name as string) ?? '',
          idioma: (v.message_template_language as string) ?? null,
          status: (v.event as string) ?? 'UNKNOWN',
          motivo: (v.reason as string) ?? null,
        })
      } else if (ch.field === 'phone_number_quality_update' || ch.field === 'account_update') {
        eventos.push({
          tipo: 'qualidade', phoneNumberId,
          evento: (v.event as string) ?? ch.field,
          detalhe: (v.current_limit as string) ?? (v.ban_state as string) ?? null,
        })
      } else {
        eventos.push({ tipo: 'ignorado', motivo: `campo_${ch.field ?? 'ausente'}` })
      }
    }
  }
  return eventos.length ? eventos : [{ tipo: 'ignorado', motivo: 'sem_changes' }]
}

/** Traduz o `messages[i]` cru da Meta para o nosso conteúdo. Puro. */
export function conteudoDaMensagemMeta(mRaw: unknown): ConteudoMeta {
  const m = mRaw as {
    type?: string
    text?: { body?: string }
    image?: { id?: string; mime_type?: string; caption?: string }
    audio?: { id?: string; mime_type?: string; voice?: boolean }
    interactive?: { type?: string; button_reply?: { id?: string; title?: string }; list_reply?: { id?: string; title?: string } }
    button?: { payload?: string; text?: string }
  }
  switch (m.type) {
    case 'text':
      return { tipo: 'texto', texto: m.text?.body ?? '' }
    case 'image':
      if (!m.image?.id) return { tipo: 'outro', tipoCru: 'image_sem_id' }
      return { tipo: 'imagem', midiaId: m.image.id, mime: m.image.mime_type ?? null, legenda: m.image.caption ?? null }
    case 'audio':
      if (!m.audio?.id) return { tipo: 'outro', tipoCru: 'audio_sem_id' }
      return { tipo: 'audio', midiaId: m.audio.id, mime: m.audio.mime_type ?? null }
    case 'interactive': {
      // Resposta a botão/lista NOSSA: o título é o que o cliente "disse".
      const r = m.interactive?.button_reply ?? m.interactive?.list_reply
      if (!r?.title) return { tipo: 'outro', tipoCru: 'interactive_sem_resposta' }
      return { tipo: 'texto', texto: r.title, ...(r.id ? { botaoId: r.id } : {}) }
    }
    case 'button':
      // Botão de TEMPLATE (quick reply): `button.text` é o rótulo clicado.
      if (!m.button?.text) return { tipo: 'outro', tipoCru: 'button_sem_texto' }
      return { tipo: 'texto', texto: m.button.text, ...(m.button.payload ? { botaoId: m.button.payload } : {}) }
    default:
      return { tipo: 'outro', tipoCru: m.type ?? 'desconhecido' }
  }
}
