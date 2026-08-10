/**
 * Protocolo de atendimento (INB-11). Número inteiro por tenant (contador), que
 * a tela mostra com zero-padding — mas a BUSCA aceita com ou sem `#` e com ou
 * sem zeros. O zero-padding é APRESENTAÇÃO; a identidade é o inteiro.
 */

/** 318 → "#000318". */
export function formatarProtocolo(n: number): string {
  return `#${String(Math.max(0, Math.trunc(n))).padStart(6, '0')}`
}

/** "#000318" | "318" | "  #318 " → 318. Devolve null se não for número. */
export function parsearProtocolo(entrada: string): number | null {
  const so = entrada.replace(/[#\s]/g, '')
  if (!/^\d+$/.test(so)) return null
  const n = Number(so)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}
