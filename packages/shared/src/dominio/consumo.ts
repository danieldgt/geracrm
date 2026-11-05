/**
 * Regras puras de CONSUMO e do mapeamento de variáveis de template (F2).
 * TypeScript puro: API, console e app usam as MESMAS funções. Dinheiro em centavos inteiros.
 */

// ── Mapeamento {{n}} -> campo ────────────────────────────────────────────────

/** Lista FECHADA de campos que um {{n}} pode receber no envio. */
export const CAMPOS_MAPEAMENTO = [
  { campo: 'contato.nome', rotulo: 'Nome do contato' },
  { campo: 'contato.nome_fantasia', rotulo: 'Nome fantasia' },
  { campo: 'contato.razao_social', rotulo: 'Razão social' },
  { campo: 'contato.email', rotulo: 'E-mail do contato' },
  { campo: 'vendedor.nome', rotulo: 'Nome do vendedor' },
  { campo: 'empresa.nome', rotulo: 'Nome da empresa' },
] as const
export type CampoMapeamento = (typeof CAMPOS_MAPEAMENTO)[number]['campo']

export function ehCampoMapeamento(c: unknown): c is CampoMapeamento {
  return typeof c === 'string' && CAMPOS_MAPEAMENTO.some((x) => x.campo === c)
}

/** Números das variáveis `{{n}}` do texto, únicos e em ordem crescente. Só posicionais (`{{1}}`). */
export function variaveisDoCorpo(texto: string): number[] {
  const achadas = new Set<number>()
  for (const m of texto.matchAll(/\{\{\s*(\d{1,2})\s*\}\}/g)) achadas.add(Number(m[1]))
  return [...achadas].sort((a, b) => a - b)
}

export type ErroMapeamento =
  | { motivo: 'campo_invalido'; variavel: string }
  | { motivo: 'variavel_inexistente'; variavel: string }

/**
 * Valida {variavel: campo} contra as variáveis que o corpo realmente tem.
 * Devolve o primeiro erro, ou null.
 */
export function validarMapeamento(
  mapa: Readonly<Record<string, unknown>>, variaveisDoTemplate: readonly number[],
): ErroMapeamento | null {
  for (const [v, campo] of Object.entries(mapa)) {
    if (!/^\d{1,2}$/.test(v) || !variaveisDoTemplate.includes(Number(v))) return { motivo: 'variavel_inexistente', variavel: v }
    if (!ehCampoMapeamento(campo)) return { motivo: 'campo_invalido', variavel: v }
  }
  return null
}

// ── Projeção e alerta do mês ─────────────────────────────────────────────────

/** Dias do mês 'YYYY-MM'. */
export function diasDoMes(mes: string): number {
  const [a, m] = mes.split('-').map(Number) as [number, number]
  return new Date(Date.UTC(a, m, 0)).getUTCDate()
}

/**
 * Projeção do gasto do mês: ritmo médio até hoje × dias do mês. Mês passado = o gasto;
 * mês futuro = 0. `hoje` é a data local do tenant ('YYYY-MM-DD').
 */
export function projetarMes(gastoCentavos: number, mes: string, hoje: string): number {
  const dias = diasDoMes(mes)
  const mesHoje = hoje.slice(0, 7)
  if (mes > mesHoje) return 0
  if (mes < mesHoje) return gastoCentavos
  const dia = Math.max(1, Math.min(dias, Number(hoje.slice(8, 10))))
  return Math.round((gastoCentavos * dias) / dia)
}

/** null abaixo de 80% do orçamento; '80' a partir de 80%; '100' a partir de 100%. Inteiros, sem float. */
export function alertaDoOrcamento(gastoCentavos: number, orcamentoCentavos: number | null): null | '80' | '100' {
  if (orcamentoCentavos === null || orcamentoCentavos <= 0) return null
  if (gastoCentavos >= orcamentoCentavos) return '100'
  if (gastoCentavos * 100 >= orcamentoCentavos * 80) return '80'
  return null
}
