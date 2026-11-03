/** Regras puras de etiquetas e origens (A4): paleta, token de cor e diferença de seleção. */

/** Paleta fixa — o mesmo conjunto que a API aceita (CHECK em `etiqueta.cor`). */
export const CORES_ETIQUETA = ['acao', 'sucesso', 'atencao', 'erro', 'ia', 'neutro'] as const
export type CorEtiqueta = (typeof CORES_ETIQUETA)[number]

export const ROTULO_COR: Record<CorEtiqueta, string> = {
  acao: 'Laranja (ação)', sucesso: 'Verde', atencao: 'Amarelo', erro: 'Vermelho', ia: 'Roxo', neutro: 'Cinza',
}

export function ehCorEtiqueta(v: string): v is CorEtiqueta {
  return (CORES_ETIQUETA as readonly string[]).includes(v)
}

/** Token CSS da cor; cor desconhecida cai no neutro (nunca quebra a tela). */
export function tokenDaCor(cor: string): string {
  if (cor === 'neutro' || !ehCorEtiqueta(cor)) return 'var(--texto-suave)'
  return `var(--${cor})`
}

/** Diferença entre a seleção atual e a salva — decide se "Salvar" fica habilitado. Ignora ordem e repetição. */
export function diferencaSelecao(
  atual: readonly string[], salva: readonly string[],
): { adicionadas: string[]; removidas: string[]; mudou: boolean } {
  const a = new Set(atual)
  const s = new Set(salva)
  const adicionadas = [...a].filter((x) => !s.has(x))
  const removidas = [...s].filter((x) => !a.has(x))
  return { adicionadas, removidas, mudou: adicionadas.length + removidas.length > 0 }
}

/** Nome do formulário: aparado, 1..max. Devolve a mensagem de erro ou null. */
export function erroDoNome(nome: string, max: number): string | null {
  const n = nome.trim()
  if (!n) return 'Informe o nome.'
  if (n.length > max) return `Use no máximo ${max} caracteres.`
  return null
}

/** Ordem da origem: inteiro 0..9999 (campo de texto). Devolve o número ou null se inválido. */
export function lerOrdem(texto: string): number | null {
  const t = texto.trim()
  if (t === '') return 0
  if (!/^\d{1,4}$/.test(t)) return null
  return Number(t)
}
