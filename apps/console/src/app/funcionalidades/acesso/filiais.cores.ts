/**
 * Paleta fixa de cores de IDENTIFICAÇÃO de filial (constantes de domínio, não tema).
 * O hex mora aqui porque a API guarda `#RRGGBB`; o template só vê a chave e o rótulo
 * e pinta a amostra por `[style.background]`. O lint de cor literal cobre a biblioteca
 * `compartilhado/ui`; templates e estilos desta tela não têm hex.
 */
export interface CorFilial { readonly chave: string; readonly rotulo: string; readonly hex: string }

export const CORES_FILIAL: readonly CorFilial[] = [
  { chave: 'azul', rotulo: 'Azul', hex: '#2563EB' },
  { chave: 'verde', rotulo: 'Verde', hex: '#16A34A' },
  { chave: 'laranja', rotulo: 'Laranja', hex: '#EA580C' },
  { chave: 'roxo', rotulo: 'Roxo', hex: '#7C3AED' },
  { chave: 'rosa', rotulo: 'Rosa', hex: '#DB2777' },
  { chave: 'turquesa', rotulo: 'Turquesa', hex: '#0D9488' },
  { chave: 'amarelo', rotulo: 'Amarelo', hex: '#CA8A04' },
  { chave: 'cinza', rotulo: 'Cinza', hex: '#64748B' },
]

export function hexDaCor(chave: string): string | null {
  return CORES_FILIAL.find((c) => c.chave === chave)?.hex ?? null
}

/** Chave da paleta para um hex vindo da API; `''` se for nulo ou fora da paleta. */
export function chaveDoHex(hex: string | null): string {
  if (!hex) return ''
  return CORES_FILIAL.find((c) => c.hex.toLowerCase() === hex.toLowerCase())?.chave ?? ''
}
