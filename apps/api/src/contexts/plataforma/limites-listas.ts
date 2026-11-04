/**
 * Tetos das listas analíticas (raia X7). Toda lista de leitura tem limite EXPLÍCITO no SQL e,
 * quando corta, devolve `...Truncado: true` — a tela diz "mostrando os N maiores".
 *
 * Padrão: `LIMIT N+1`; se vier N+1 linhas, corta para N e marca truncado.
 * Ranking de leitura (top-N) → N fixo. Lista de equipe (vendedores, atendentes) → teto alto.
 */

/**
 * Teto de linhas por EQUIPE (um item por vendedor ou atendente). A equipe de um tenant é
 * dezenas; 200 cobre com folga e só serve de freio para dado sujo (usuário fantasma em massa).
 */
export const TETO_EQUIPE = 200
