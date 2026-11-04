import { ICONES } from './icones-lucide.js'

export type TipoEstado = 'vazio' | 'erro' | 'sem-permissao'

const PADRAO: Record<TipoEstado, string> = { vazio: 'inbox', erro: 'alert-triangle', 'sem-permissao': 'lock' }

/** Decide o que o `ui-estado` desenha: nome de ícone conhecido vira `ui-icone`; qualquer outro valor (emoji legado) vira texto. */
export function iconeDoEstado(tipo: TipoEstado, icone: string): { ehIcone: boolean; valor: string } {
  const valor = icone || PADRAO[tipo]
  return { ehIcone: Object.hasOwn(ICONES, valor), valor }
}
