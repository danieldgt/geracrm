/**
 * Regras PURAS do menu "⋯" (ações secundárias de um cabeçalho). Sem Angular.
 */

export interface ItemMenuMais {
  readonly id: string
  readonly rotulo: string
  /** Ação destrutiva: vai por último e em cor de perigo. */
  readonly perigo?: boolean
  readonly desabilitado?: boolean
  /** Por que está desabilitado (ou o que faz) — vira o title. */
  readonly dica?: string
}

/**
 * Próximo item com o teclado (setas circulares, Home, End), pulando os
 * desabilitados. `atual` = -1 quando nenhum item tem foco. Devolve null para
 * outras teclas ou quando não há item habilitado.
 */
export function proximoItemMenu(itens: readonly ItemMenuMais[], atual: number, tecla: string): number | null {
  const habilitados = itens.map((it, i) => (it.desabilitado ? -1 : i)).filter((i) => i >= 0)
  if (habilitados.length === 0) return null
  const pos = habilitados.indexOf(atual)
  switch (tecla) {
    case 'ArrowDown': return habilitados[(pos + 1) % habilitados.length]!
    case 'ArrowUp': return habilitados[(pos <= 0 ? habilitados.length : pos) - 1]!
    case 'Home': return habilitados[0]!
    case 'End': return habilitados[habilitados.length - 1]!
    default: return null
  }
}

/** Destrutivos sempre por último, na ordem em que vieram (a ordem entre os demais é de quem chama). */
export function ordenarItensMenu(itens: readonly ItemMenuMais[]): ItemMenuMais[] {
  return [...itens.filter((i) => !i.perigo), ...itens.filter((i) => i.perigo)]
}
