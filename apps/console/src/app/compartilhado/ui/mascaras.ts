import { apenasDigitos } from '@geracrm/shared'

/**
 * Máscaras de exibição (puras). A regra de VALIDAÇÃO (dígito verificador)
 * fica em `@geracrm/shared` (`validarCpf`/`validarCnpj`); aqui só se formata.
 * Todas aceitam texto parcial, colado com pontuação ou vazio — nunca lançam.
 */
export type TipoMascara = 'cpf' | 'cnpj' | 'cpfCnpj' | 'telefone' | 'cep'

/** Só dígitos. Reuso direto de shared — uma regra só. */
export const soDigitos = apenasDigitos

/** Aplica um molde onde `0` é um dígito; corta o excedente e não deixa pontuação pendurada. */
function aplicarMolde(digitos: string, molde: string): string {
  let saida = ''
  let i = 0
  for (const c of molde) {
    if (i >= digitos.length) break
    if (c === '0') saida += digitos[i++]
    else saida += c
  }
  return saida
}

export function formatarCpf(bruto: string): string {
  return aplicarMolde(soDigitos(bruto).slice(0, 11), '000.000.000-00')
}

export function formatarCnpj(bruto: string): string {
  return aplicarMolde(soDigitos(bruto).slice(0, 14), '00.000.000/0000-00')
}

/** Até 11 dígitos é CPF; a partir do 12º vira CNPJ. */
export function formatarCpfCnpj(bruto: string): string {
  const d = soDigitos(bruto)
  return d.length > 11 ? formatarCnpj(d) : formatarCpf(d)
}

export function formatarCep(bruto: string): string {
  return aplicarMolde(soDigitos(bruto).slice(0, 8), '00000-000')
}

/**
 * Fixo (10 dígitos) e celular (11). Com DDI 55 (12 ou 13 dígitos) mostra "+55 ".
 * ⚠️ 55 também é DDD (RS): só tratamos como país quando já há 12+ dígitos; durante
 * a digitação de um número com DDD 55 a máscara não adivinha.
 */
export function formatarTelefone(bruto: string): string {
  let d = soDigitos(bruto)
  let prefixo = ''
  if (d.startsWith('55') && d.length >= 12) {
    prefixo = '+55 '
    d = d.slice(2, 13)
  } else {
    d = d.slice(0, 11)
  }
  if (!d) return ''
  const ddd = d.slice(0, 2)
  const resto = d.slice(2)
  if (!resto) return `${prefixo}(${ddd}`
  const corte = d.length === 11 ? 5 : 4
  const corpo = resto.length > corte ? `${resto.slice(0, corte)}-${resto.slice(corte)}` : resto
  return `${prefixo}(${ddd}) ${corpo}`
}

const FORMATADORES: Record<TipoMascara, (bruto: string) => string> = {
  cpf: formatarCpf, cnpj: formatarCnpj, cpfCnpj: formatarCpfCnpj, telefone: formatarTelefone, cep: formatarCep,
}

export function formatarMascara(tipo: TipoMascara, bruto: string): string {
  return FORMATADORES[tipo](bruto)
}

/** O que vai para o controle: só dígitos, já respeitando o limite do tipo. */
export function digitosDaMascara(tipo: TipoMascara, bruto: string): string {
  return soDigitos(formatarMascara(tipo, bruto))
}
