/**
 * Dinheiro na tela: R$ digitado ↔ centavos inteiros (regra da casa: nunca float
 * no domínio). Puro — testado em dinheiro.spec.ts.
 *
 * ⚠️ Conversão sobre o TEXTO, não `Number(x) * 100`: `12.34 * 100` dá
 * `1233.9999999999998`. O mesmo motivo de `decimalParaCentavos` em shared, que
 * só aceita ponto; aqui a pessoa digita em pt-BR ("1.234,56") e também pode
 * colar "1234.56" — os dois formatos resolvem sem ambiguidade.
 */

/**
 * "1.234,56" → 123456 · "1234,5" → 123450 · "1234" → 123400 · "12.50" → 1250.
 * Devolve `null` para texto vazio ou inválido (a tela decide a mensagem).
 */
export function reaisParaCentavos(texto: string): number | null {
  const bruto = texto.replace(/\s|R\$/g, '')
  if (!bruto) return null
  let normal: string
  if (bruto.includes(',')) {
    // pt-BR: ponto é milhar, vírgula é decimal.
    normal = bruto.replace(/\./g, '').replace(',', '.')
  } else {
    // Só pontos: um ponto seguido de 1-2 dígitos é decimal ("12.5"); três dígitos
    // repetidos são milhar ("1.234" / "1.234.567").
    const pontos = bruto.split('.')
    normal = pontos.length > 1 && pontos.slice(1).every((p) => p.length === 3)
      ? pontos.join('')
      : bruto
  }
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(normal)
  if (!m) return null
  const inteira = Number(m[1])
  const decimal = Number(((m[2] ?? '') + '00').slice(0, 2))
  return inteira * 100 + decimal
}

/** 123456 → "1234,56" — para preencher um campo de edição (sem R$, sem milhar). */
export function centavosParaReais(centavos: number | null | undefined): string {
  if (centavos === null || centavos === undefined || !Number.isFinite(centavos)) return ''
  const sinal = centavos < 0 ? '-' : ''
  const abs = Math.abs(Math.round(centavos))
  return `${sinal}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`
}

/** 123456 → "R$ 1.234,56" — para exibição. */
export function formatarReais(centavos: number): string {
  return (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}
