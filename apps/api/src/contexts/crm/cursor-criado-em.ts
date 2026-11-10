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
  if (!em || !id || !UUID.test(id) || !TIMESTAMP.test(em) || !dataHoraReal(em)) return 'invalido'
  return { em, id }
}

/**
 * O regex só olha o formato. `Date.parse` aceita `2026-02-30` (rola para março) e o Postgres
 * recusa com erro de faixa → 500. Confere o dia no calendário e que a hora existe.
 */
function dataHoraReal(em: string): boolean {
  const [a, m, d] = em.slice(0, 10).split('-').map(Number) as [number, number, number]
  const dia = new Date(Date.UTC(a, m - 1, d))
  const calendarioOk = dia.getUTCFullYear() === a && dia.getUTCMonth() === m - 1 && dia.getUTCDate() === d
  return calendarioOk && !Number.isNaN(Date.parse(em))
}

/**
 * Cursor opaco a partir do instante como TEXTO do Postgres (`coluna::text`) e do id.
 * ⚠️ Nunca passe `Date#toISOString()` aqui: corta os µs (ver o topo do arquivo).
 */
export function montarCursor(emTexto: string, id: string): string {
  return Buffer.from(`${emTexto}${SEPARADOR}${id}`).toString('base64url')
}

/** Corta a página (PAGINA+1 linhas lidas) e monta o próximo cursor. */
export function paginar<T extends { id: string; criado_em_txt: string }>(
  linhas: readonly T[],
): { pagina: readonly T[]; proximoCursor: string | null } {
  const temMais = linhas.length > PAGINA
  const pagina = temMais ? linhas.slice(0, PAGINA) : linhas
  const ultimo = pagina[pagina.length - 1]
  const proximoCursor = temMais && ultimo ? montarCursor(ultimo.criado_em_txt, ultimo.id) : null
  return { pagina, proximoCursor }
}

/**
 * Instante avulso vindo do cliente (ex.: `anteriorEm` do histórico): o mesmo formato e a
 * mesma checagem de calendário do cursor. `null` = inválido (→ 422, nunca 500 no banco).
 */
export function lerInstante(bruto: string | undefined): string | null {
  return bruto && TIMESTAMP.test(bruto) && dataHoraReal(bruto) ? bruto : null
}
