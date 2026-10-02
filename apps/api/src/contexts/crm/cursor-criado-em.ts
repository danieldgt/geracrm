/**
 * Cursor keyset por (criado_em, id) — o mesmo desenho de rotas-bloqueios.ts,
 * reusado pelas listas de configuração (sequências, automações, webhooks).
 *
 * ⚠️ Lista por cursor, nunca OFFSET nem `LIMIT 200` cru (regra da casa: grids
 * sem paginação derrubaram o Postgres do GeraCloud). 20 por página.
 *
 * ⚠️ O timestamp viaja como TEXTO do Postgres (`criado_em::text`), com
 * microssegundos. `Date#toISOString()` corta em milissegundos — e 23 linhas
 * criadas num laço cabem no mesmo milissegundo: a 2ª página perdia itens.
 *
 * ⚠️ E na query o parâmetro entra como `${em}::text::timestamptz`, NUNCA
 * `${em}::timestamptz`: com o cast direto o servidor infere o parâmetro como
 * timestamptz e o postgres.js passa a serializá-lo via `Date` — de novo em
 * milissegundos. O `::text` no meio mantém o parâmetro como texto.
 */
export const PAGINA = 20
const SEPARADOR = '§'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** `2026-10-02 14:34:14.123456+00` (o que `timestamptz::text` devolve). */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)$/

export function lerCursor(bruto: string | undefined): { em: string; id: string } | null | 'invalido' {
  if (!bruto) return null
  const [em, id] = Buffer.from(bruto, 'base64url').toString('utf8').split(SEPARADOR)
  if (!em || !id || !UUID.test(id) || !TIMESTAMP.test(em)) return 'invalido'
  return { em, id }
}

/** Corta a página (PAGINA+1 linhas lidas) e monta o próximo cursor. */
export function paginar<T extends { id: string; criado_em_txt: string }>(
  linhas: readonly T[],
): { pagina: readonly T[]; proximoCursor: string | null } {
  const temMais = linhas.length > PAGINA
  const pagina = temMais ? linhas.slice(0, PAGINA) : linhas
  const ultimo = pagina[pagina.length - 1]
  const proximoCursor = temMais && ultimo
    ? Buffer.from(`${ultimo.criado_em_txt}${SEPARADOR}${ultimo.id}`).toString('base64url')
    : null
  return { pagina, proximoCursor }
}
