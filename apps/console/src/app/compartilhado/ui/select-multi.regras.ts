import type { OpcaoPaginada } from './select-paginado.estado.js'

/** Regras puras do `ui-select-multi`: testáveis em node, sem TestBed. */

/** Acrescenta o id respeitando duplicata e o limite opcional. Devolve a MESMA lista se nada mudou. */
export function adicionarId(ids: readonly string[], id: string, max: number | null): readonly string[] {
  if (ids.includes(id)) return ids
  if (max !== null && ids.length >= max) return ids
  return [...ids, id]
}

export function removerId(ids: readonly string[], id: string): readonly string[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : ids
}

export function limiteAtingido(total: number, max: number | null): boolean {
  return max !== null && total >= max
}

/** Rótulo do chip: cache do carregador (mais novo) > opções injetadas > o próprio id (nunca vazio). */
export function rotuloDoChip(id: string, cache: ReadonlyMap<string, string>, injetadas: readonly OpcaoPaginada[]): string {
  return cache.get(id) ?? injetadas.find((o) => o.valor === id)?.rotulo ?? id
}
