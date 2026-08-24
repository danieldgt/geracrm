/**
 * Conversão de custo de mídia para CENTAVOS INTEIROS — a borda onde o dinheiro
 * das plataformas entra no nosso domínio.
 *
 * ⚠️ Vive em `packages/shared` (TS puro) porque é REGRA: o console mostra ROAS,
 * a API calcula e o worker sincroniza. Uma conversão duplicada em três lugares
 * diverge no primeiro ajuste de arredondamento — e diverge em DINHEIRO.
 *
 * Cada plataforma devolve custo num formato diferente, e os dois têm armadilha:
 *
 * | Plataforma | Formato          | Armadilha                                    |
 * |------------|------------------|----------------------------------------------|
 * | Google     | micros (inteiro) | 1 unidade = 1.000.000 micros; 1 centavo = 10.000 |
 * | Meta       | decimal em TEXTO | ⚠️ `parseFloat('12.34') * 100 === 1233.9999…` |
 */

/** Micros por centavo: 1 unidade monetária = 1.000.000 micros = 100 centavos. */
const MICROS_POR_CENTAVO = 10_000

/**
 * Google Ads: `cost_micros` → centavos.
 *
 * ⚠️ **Arredonda, nunca trunca.** Truncar tem erro sempre no mesmo sentido, e
 * num ano de sincronização diária por anúncio o desvio vira dinheiro visível no
 * relatório. Arredondar tem erro simétrico, que se cancela na soma.
 */
export function microsParaCentavos(micros: number | bigint): number {
  const n = typeof micros === 'bigint' ? Number(micros) : micros
  if (!Number.isFinite(n)) throw new TypeError('micros precisa ser finito')
  return Math.round(n / MICROS_POR_CENTAVO)
}

/**
 * Meta: `spend` como `"12.34"` → centavos.
 *
 * ⚠️ **Não passa por float.** `parseFloat('12.34') * 100` devolve
 * `1233.9999999999998`, e um `Math.floor` ali cobraria um centavo a menos do
 * cliente em parte das linhas. A conversão é feita sobre o TEXTO: separa a parte
 * inteira da decimal, e só arredonda o que sobra além do segundo dígito.
 *
 * Aceita `"12"`, `"12.3"`, `"12.34"`, `"12.345"` (arredonda), `"-1.5"`, `"1e3"`
 * é REJEITADO de propósito — notação científica em campo de dinheiro é sinal de
 * que a origem mudou de formato, e falhar alto é melhor que converter errado.
 */
export function decimalParaCentavos(valor: string): number {
  const texto = valor.trim()
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(texto)
  if (!m) throw new TypeError(`valor monetário inesperado: ${JSON.stringify(valor)}`)

  const [, sinal, inteira, decimal = ''] = m
  const centavosInteiros = Number(inteira) * 100
  // Dois primeiros dígitos decimais são centavos; o terceiro em diante arredonda.
  const doisPrimeiros = Number((decimal + '00').slice(0, 2))
  const resto = decimal.slice(2)
  const arredondaParaCima = resto.length > 0 && Number(resto[0]) >= 5
  const total = centavosInteiros + doisPrimeiros + (arredondaParaCima ? 1 : 0)
  return sinal === '-' ? -total : total
}

/**
 * Soma custos já em centavos, defendendo contra o `bigint` que o driver devolve
 * como **string** (INV-46 / regra da skill `geracrm-dados-postgres`).
 *
 * ⚠️ `"2" + "3"` é `"23"` em JavaScript — sem erro, sem aviso, número errado no
 * dashboard. Esta função existe para que esse acidente não tenha onde acontecer.
 */
export function somarCentavos(valores: readonly (number | string | bigint)[]): number {
  let total = 0
  for (const v of valores) {
    const n = typeof v === 'number' ? v : Number(v)
    if (!Number.isFinite(n)) throw new TypeError(`custo não numérico: ${JSON.stringify(v)}`)
    total += n
  }
  return total
}

/**
 * ROAS = receita ÷ custo. `null` quando não há custo — ⚠️ dividir por zero
 * devolveria `Infinity`, que numa tela vira "∞" e numa soma contamina tudo.
 *
 * ⚠️ Quem chama precisa dizer QUAL receita está passando (exata ou estimada) e
 * declarar a janela ao lado do número (AMK-009). Esta função não sabe a
 * diferença — e é justamente por isso que ela não pode ser usada sem rótulo.
 */
export function calcularRoas(receitaCentavos: number, custoCentavos: number): number | null {
  if (custoCentavos <= 0) return null
  return receitaCentavos / custoCentavos
}

/**
 * As plataformas de anúncio que a camada de aquisição conhece.
 *
 * ⚠️ Fonte única para API e console, e espelho do CHECK
 * `midia_conta_plataforma_valida` (migration 0058). Crescer aqui obriga a crescer
 * lá — INV-48 proíbe enum no banco, então a coerência é por disciplina e teste.
 */
export type Plataforma = 'google' | 'meta' | 'tiktok'

export const PLATAFORMAS: readonly Plataforma[] = ['google', 'meta', 'tiktok'] as const
