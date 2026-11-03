/** Regras puras dos componentes de lista (sem DOM, testáveis em node). */

export type EstadoSelecaoPagina = 'nenhum' | 'parcial' | 'todos'

/** Estado do checkbox "todos desta página": só olha as chaves visíveis. */
export function estadoSelecaoPagina(selecionados: ReadonlySet<string>, chavesPagina: readonly string[]): EstadoSelecaoPagina {
  if (chavesPagina.length === 0) return 'nenhum'
  const n = chavesPagina.filter((k) => selecionados.has(k)).length
  return n === 0 ? 'nenhum' : n === chavesPagina.length ? 'todos' : 'parcial'
}

/** Marca todas as chaves da página, ou desmarca todas se já estavam todas marcadas. Preserva o resto. */
export function alternarPagina(selecionados: ReadonlySet<string>, chavesPagina: readonly string[]): Set<string> {
  const novo = new Set(selecionados)
  const desmarcar = estadoSelecaoPagina(selecionados, chavesPagina) === 'todos'
  for (const k of chavesPagina) { if (desmarcar) novo.delete(k); else novo.add(k) }
  return novo
}

export function alternarChave(selecionados: ReadonlySet<string>, chave: string): Set<string> {
  const novo = new Set(selecionados)
  if (novo.has(chave)) novo.delete(chave); else novo.add(chave)
  return novo
}

/** "Mostrando 25" ou "Mostrando 25 de 11.000". */
export function textoMostrando(mostrados: number, total?: number | null): string {
  const f = (n: number): string => n.toLocaleString('pt-BR')
  return total === undefined || total === null ? `Mostrando ${f(mostrados)}` : `Mostrando ${f(mostrados)} de ${f(total)}`
}

/** "1 selecionado" / "3 selecionados". */
export function textoSelecionados(n: number): string {
  return n === 1 ? '1 selecionado' : `${n.toLocaleString('pt-BR')} selecionados`
}

/** Valor de célula padrão (sem template): vazio para null/undefined. */
export function textoDaCelula(valor: unknown): string {
  return valor === null || valor === undefined ? '' : String(valor)
}

/** Debounce com cancelamento. O relógio é o setTimeout global (fake timers em teste). */
export function comDebounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): ((...a: A) => void) & { cancelar: () => void } {
  let t: ReturnType<typeof setTimeout> | undefined
  const f = (...a: A): void => { if (t) clearTimeout(t); t = setTimeout(() => { t = undefined; fn(...a) }, ms) }
  f.cancelar = (): void => { if (t) clearTimeout(t); t = undefined }
  return f
}
