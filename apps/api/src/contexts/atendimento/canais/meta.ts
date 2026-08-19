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

export type EventoMeta =
  | { tipo: 'mensagem'; phoneNumberId: string; de: string; idExterno: string; timestamp: number
      conteudo: { tipo: string; texto?: string }; nomePerfil: string | null }
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
          const m = mRaw as { from?: string; id?: string; timestamp?: string; type?: string; text?: { body?: string } }
          if (!m.from || !m.id || !phoneNumberId) { eventos.push({ tipo: 'ignorado', motivo: 'mensagem_incompleta' }); continue }
          eventos.push({
            tipo: 'mensagem', phoneNumberId, de: m.from, idExterno: m.id,
            timestamp: Number(m.timestamp ?? 0),
            conteudo: m.type === 'text' ? { tipo: 'texto', texto: m.text?.body ?? '' } : { tipo: m.type ?? 'desconhecido' },
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
