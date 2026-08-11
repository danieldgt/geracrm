/**
 * Channel identity — the single source of truth for "which channel a conversation
 * arrived through", shared by the API payloads, the console inbox and the Expo app.
 *
 * ⚠️ TypeScript only, no framework imports (this file is consumed by Angular, Expo
 * and the API at once — see index.ts). The brand SVG logo lives in the UI layer;
 * here we only decide type → family → human label. Keeping the mapping here is what
 * stops three consumers from each inventing their own channel label.
 *
 * ADR-021: the channel is dual for WhatsApp (oficial priority, não-oficial optional)
 * and the port is generic — Instagram and TikTok are more adapters behind it.
 */

/**
 * The channel type as stored in `canal_conectado.tipo` (see the CHECK constraint in
 * infra/migrations/0024_canal_provedor.sql and 0051_canal_tiktok.sql). A new
 * non-official WhatsApp provider does NOT add a value here — it is still
 * `whatsapp_nao_oficial`, distinguished by `provedor`.
 */
export type TipoCanal =
  | 'whatsapp_oficial'
  | 'whatsapp_nao_oficial'
  | 'instagram'
  | 'tiktok'

/**
 * The brand family — what logo/color to paint. Both WhatsApp types collapse to the
 * same brand mark; the oficial/não-oficial distinction is carried by the label and
 * by the ban-risk badge, not by the logo.
 */
export type FamiliaCanal = 'whatsapp' | 'instagram' | 'tiktok'

const FAMILIA: Record<TipoCanal, FamiliaCanal> = {
  whatsapp_oficial: 'whatsapp',
  whatsapp_nao_oficial: 'whatsapp',
  instagram: 'instagram',
  tiktok: 'tiktok',
}

const ROTULO: Record<TipoCanal, string> = {
  whatsapp_oficial: 'WhatsApp',
  whatsapp_nao_oficial: 'WhatsApp (não-oficial)',
  instagram: 'Instagram',
  tiktok: 'TikTok',
}

/** Brand family for a channel type — drives which logo the UI renders. */
export function familiaCanal(tipo: TipoCanal): FamiliaCanal {
  return FAMILIA[tipo] ?? 'whatsapp'
}

/** Human label for a channel type, shown next to the brand mark. */
export function rotuloCanal(tipo: TipoCanal): string {
  return ROTULO[tipo] ?? tipo
}

/**
 * ⚠️ The não-oficial WhatsApp path carries a ban risk that the interface MUST make
 * visible (ADR-021). This is the single predicate the UI uses for that alert.
 */
export function riscoBanimentoCanal(tipo: TipoCanal): boolean {
  return tipo === 'whatsapp_nao_oficial'
}
