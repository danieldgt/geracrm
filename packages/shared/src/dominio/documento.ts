/**
 * Validação de CNPJ/CPF por dígito verificador. Puro, sem dependência.
 *
 * ⚠️ Validar de verdade (dígito), não só o tamanho: um CNPJ com dígito errado
 * é recusado pelo ERP na efetivação — barrar aqui evita o pedido morrer lá.
 */

/** Só dígitos. */
export function apenasDigitos(bruto: string): string {
  return (bruto ?? '').replace(/\D/g, '')
}

function digitosVerificadores(base: string, pesosIniciais: number): boolean {
  // Algoritmo módulo 11 para CPF (base 9) e CNPJ (base 12).
  const calc = (parcial: string, pesoInicial: number): number => {
    let soma = 0
    let peso = pesoInicial
    for (const ch of parcial) {
      soma += Number(ch) * peso
      peso = peso === 2 ? 9 : peso - 1
    }
    const resto = soma % 11
    return resto < 2 ? 0 : 11 - resto
  }
  const corpo = base.slice(0, -2)
  const d1 = calc(corpo, pesosIniciais)
  const d2 = calc(corpo + d1, pesosIniciais + 1)
  return base.endsWith(`${d1}${d2}`)
}

export function validarCpf(bruto: string): boolean {
  const d = apenasDigitos(bruto)
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false // todos iguais é inválido
  return digitosVerificadores(d, 10)
}

export function validarCnpj(bruto: string): boolean {
  const d = apenasDigitos(bruto)
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false
  return digitosVerificadores(d, 5)
}

export type TipoDocumento = 'cnpj' | 'cpf'

/** Valida e normaliza (só dígitos) conforme o tipo. null = inválido. */
export function normalizarDocumento(tipo: TipoDocumento, bruto: string): string | null {
  const d = apenasDigitos(bruto)
  if (tipo === 'cnpj') return validarCnpj(d) ? d : null
  return validarCpf(d) ? d : null
}
