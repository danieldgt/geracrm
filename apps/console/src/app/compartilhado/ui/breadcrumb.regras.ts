export interface ItemTrilha { readonly rotulo: string; readonly rota?: string }
export interface ItemTrilhaVista extends ItemTrilha { readonly link: boolean }

/** O último item é a página atual: nunca é link, mesmo com rota. */
export function itensDaTrilha(itens: readonly ItemTrilha[]): ItemTrilhaVista[] {
  return itens.map((i, n) => ({ ...i, link: n < itens.length - 1 && !!i.rota }))
}
