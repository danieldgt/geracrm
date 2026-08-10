/**
 * Parse + validação de data URL de mídia (E5-14). Puro — sem rede, sem estado.
 *
 * ⚠️ A validação de tipo/tamanho é NO SERVIDOR, antes de subir: o cliente pode
 * mandar qualquer coisa. Limite existe para não engolir upload de 200 MB nem
 * tipo que o WhatsApp não aceita.
 */

/** WhatsApp aceita estes; o resto recusamos com motivo nomeado. */
const MIME_PERMITIDOS = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/webm',
])

/** 16 MB — teto do WhatsApp para mídia; acima disso o provedor recusaria. */
export const LIMITE_BYTES = 16 * 1024 * 1024

export type MidiaDecodificada =
  | { ok: true; mime: string; bytes: Buffer }
  | { ok: false; motivo: 'formato_invalido' | 'tipo_nao_suportado' | 'muito_grande' }

const RE_DATA_URL = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/i

/** Reconhece um data URL base64 (o que a tela manda hoje). */
export function ehDataUrl(valor: string): boolean {
  return RE_DATA_URL.test(valor)
}

export function decodificarMidia(dataUrl: string): MidiaDecodificada {
  const m = RE_DATA_URL.exec(dataUrl)
  if (!m) return { ok: false, motivo: 'formato_invalido' }
  const mime = m[1]!.toLowerCase()
  if (!MIME_PERMITIDOS.has(mime)) return { ok: false, motivo: 'tipo_nao_suportado' }

  const bytes = Buffer.from(m[2]!, 'base64')
  if (bytes.length === 0) return { ok: false, motivo: 'formato_invalido' }
  if (bytes.length > LIMITE_BYTES) return { ok: false, motivo: 'muito_grande' }
  return { ok: true, mime, bytes }
}
