/**
 * Paginação por cursor — o "carregar mais" sem duplicata.
 *
 * ⚠️ Entre uma página e a próxima o mundo anda: um item novo entra no topo, um
 * evento de tempo real reordena a lista. A página seguinte pode então repetir
 * um item que a tela já mostra — e `@for … track id` com id repetido é erro em
 * runtime no Angular. Mesclar por chave resolve na origem.
 */
export function mesclarPagina<T>(
  atual: readonly T[],
  novos: readonly T[],
  chave: (item: T) => string | number,
): T[] {
  const vistos = new Set(atual.map(chave))
  const saida = [...atual]
  for (const n of novos) {
    const k = chave(n)
    if (vistos.has(k)) continue
    vistos.add(k)
    saida.push(n)
  }
  return saida
}

/** Monta a query string de uma lista por cursor, omitindo o que está vazio. */
export function queryDeLista(params: Record<string, string | number | null | undefined>): string {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue
    qs.set(k, String(v))
  }
  const s = qs.toString()
  return s ? `?${s}` : ''
}
