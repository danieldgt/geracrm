/**
 * Busca textual de lista no servidor (`?q=`). Infra neutra de contexto: cada rota
 * decide o que pesquisar; aqui só mora o que é igual para todas.
 */

/** Teto do termo: a busca é por nome curto; acima disso é entrada suspeita, não busca. */
export const TAMANHO_MAX_BUSCA = 100

/**
 * Escapa `\`, `%` e `_` para o ILIKE tratar o termo como texto literal. O escape padrão
 * do Postgres é a barra invertida, então o padrão resultante não precisa de `ESCAPE`.
 */
export function escaparLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/** Padrão "contém" para `ILIKE`, com o termo literal entre os curingas. */
export function padraoContem(termo: string): string {
  return `%${escaparLike(termo)}%`
}

/**
 * Lê o `?q=`. Ausente ou só espaços → `null` (sem filtro). Não-texto ou longo demais →
 * `'invalido'`, para a rota responder 422 com `campos.q`.
 */
export function lerBusca(bruto: unknown): string | null | 'invalido' {
  if (bruto === undefined) return null
  if (typeof bruto !== 'string') return 'invalido'
  const termo = bruto.trim()
  if (termo === '') return null
  return termo.length > TAMANHO_MAX_BUSCA ? 'invalido' : termo
}
