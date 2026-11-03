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

/**
 * Poda a seleção às chaves visíveis. Devolve a MESMA referência quando nada sai (evita
 * disparar o `model` à toa). Seleção que sobrevive a troca de página/filtro é a pegadinha
 * clássica do lote: o usuário vê "2 selecionados" e a ação roda em linhas que ele não vê.
 */
export function podarSelecao(selecionados: ReadonlySet<string>, chavesVisiveis: readonly string[]): ReadonlySet<string> {
  if (selecionados.size === 0) return selecionados
  const visiveis = new Set(chavesVisiveis)
  const mantidos = [...selecionados].filter((k) => visiveis.has(k))
  return mantidos.length === selecionados.size ? selecionados : new Set(mantidos)
}

/**
 * Chave padrão da linha: `id`. Em desenvolvimento, linha sem `id` LANÇA erro claro — antes,
 * todas viravam "undefined" e a seleção/`track` colapsavam numa linha só, sem aviso.
 */
export function chavePadraoDaLinha(linha: Record<string, unknown>, dev = true): string {
  const id = linha['id']
  if (id === null || id === undefined) {
    if (dev) throw new Error('ui-tabela: linha sem "id". Informe [chaveLinha] ou inclua um id em cada linha.')
    return String(id)
  }
  return String(id)
}

/** Rótulo do checkbox da linha: "Selecionar <rótulo>" ou, sem rótulo, "Selecionar linha N" (1-based). */
export function rotuloSelecaoDaLinha(rotulo: string | null | undefined, indice: number): string {
  const r = rotulo?.trim()
  return r ? `Selecionar ${r}` : `Selecionar linha ${indice + 1}`
}
