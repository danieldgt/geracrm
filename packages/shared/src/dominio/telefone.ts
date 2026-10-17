/**
 * Brazilian phone normalisation.
 *
 * ⚠️ Normalise on WRITE, never on read. `+55 81 99861-7049`, `5581998617049` and
 * `81998617049` must collide on the same key — otherwise the contact base silently
 * duplicates as records arrive from the ERP, from WhatsApp and from CSV import.
 *
 * There are TWO keys, and confusing them is a real bug:
 *
 *  - `e164`          — the canonical number used to send. Includes the 9th digit.
 *  - `chaveBloqueio` — 55 + DDD + last 8 digits. Used by the block list (INV-50),
 *                      because the same person appears with and without the 9th
 *                      digit across systems, and an opt-out must hold for both.
 *
 * INV-07 · INV-49 · INV-50 · CTT-02
 */

export interface TelefoneNormalizado {
  readonly e164: string
  readonly chaveBloqueio: string
  readonly ddd: string
  readonly assinante: string
}

const DDDS_VALIDOS = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 24, 27, 28,
  31, 32, 33, 34, 35, 37, 38, 41, 42, 43, 44, 45, 46, 47, 48, 49,
  51, 53, 54, 55, 61, 62, 63, 64, 65, 66, 67, 68, 69,
  71, 73, 74, 75, 77, 79, 81, 82, 83, 84, 85, 86, 87, 88, 89,
  91, 92, 93, 94, 95, 96, 97, 98, 99,
])

/**
 * @returns null when the input cannot be a Brazilian mobile number.
 *          ⚠️ Returning null is the point: a silently "fixed" wrong number
 *          sends a customer's message to a stranger.
 */
export function normalizarTelefone(bruto: string): TelefoneNormalizado | null {
  let d = bruto.replace(/\D/g, '')

  // Drop the international access prefix if it came typed (00 55 ...).
  if (d.startsWith('00')) d = d.slice(2)
  // Country code: add when missing, keep when present.
  if (!d.startsWith('55')) d = `55${d}`

  const nacional = d.slice(2)
  if (nacional.length < 10 || nacional.length > 11) return null

  const ddd = nacional.slice(0, 2)
  if (!DDDS_VALIDOS.has(Number(ddd))) return null

  let assinante = nacional.slice(2)

  // Mobile numbers carry a leading 9. Landlines (8 digits starting with 2..5)
  // are kept as-is — a shop's landline is a legitimate contact, it just cannot
  // receive WhatsApp.
  if (assinante.length === 8 && /^[6-9]/.test(assinante)) {
    assinante = `9${assinante}`
  }

  return {
    e164: `+55${ddd}${assinante}`,
    // Last 8 digits: collides with and without the 9th digit — that is the whole point.
    chaveBloqueio: `55${ddd}${assinante.slice(-8)}`,
    ddd,
    assinante,
  }
}

export function ehMovel(t: TelefoneNormalizado): boolean {
  return t.assinante.length === 9 && t.assinante.startsWith('9')
}

/**
 * E.164 → leitura humana: `5585998617049` vira `+55 (85) 99861-7049`.
 *
 * ⚠️ Formatting is for READING only — never store or compare the result. The
 * keys stay `e164`/`chaveBloqueio`; a formatted string in a lookup is how the
 * same person becomes two contacts again.
 *
 * ⚠️ Anything that is not a Brazilian number comes back UNCHANGED instead of
 * being reshaped into something that looks Brazilian but is not.
 */
export function formatarTelefoneBR(e164: string): string {
  const d = e164.replace(/\D/g, '')
  if (!d.startsWith('55') || d.length < 12 || d.length > 13) return e164
  const ddd = d.slice(2, 4)
  const assinante = d.slice(4)
  return `+55 (${ddd}) ${assinante.slice(0, assinante.length - 4)}-${assinante.slice(-4)}`
}

/**
 * Phone shown MASKED: keeps country + area code and the last 4 digits —
 * `+5585998617049` becomes `+55 (85) •••••-7049`.
 *
 * ⚠️ LGPD + least privilege: the fleet screen is read by managers who need to
 * tell numbers apart, not dial them. The full number never has to leave the
 * server for that, so the API masks BEFORE answering — the console never
 * receives a clear value to hide.
 *
 * ⚠️ Already masked input (`•`, `*`) comes back unchanged, so masking twice is
 * harmless. Input too short to be a phone is fully masked instead of echoed:
 * an unknown shape must not leak by falling through.
 */
export function mascararTelefone(bruto: string | null | undefined): string | null {
  if (!bruto) return null
  if (/[•*]/.test(bruto)) return bruto
  const d = bruto.replace(/\D/g, '')
  if (d.length < 8) return '••••'
  const fim = d.slice(-4)
  if (d.startsWith('55') && d.length >= 12 && d.length <= 13) return `+55 (${d.slice(2, 4)}) •••••-${fim}`
  return `+${d.slice(0, 2)} •••••-${fim}`
}

/**
 * Opaque provider id (Meta `phone_number_id`, Instagram page id) shown as
 * `••••5678`: enough to match against the Meta Business screen, not enough to
 * reuse. Short values are fully masked — the last 4 of a 5-char id IS the id.
 */
export function mascararIdentificador(bruto: string | null | undefined): string | null {
  if (!bruto) return null
  const v = bruto.trim()
  if (v.length < 8) return '••••'
  return `••••${v.slice(-4)}`
}
