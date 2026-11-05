import { apenasDigitos, validarCnpj } from './documento.js'

/**
 * CONFIGURAÇÕES DA EMPRESA (raia D5) — contato, LGPD e módulos. Puro, sem
 * dependência: a API é a regra (422 por campo) e o console usa a MESMA função
 * como conveniência, antes de enviar.
 *
 * Entrada parcial: só os campos presentes são validados e entram no resultado.
 * Texto vazio em campo opcional LIMPA (vira null).
 */

export const UFS = [
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA',
  'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO',
] as const

export const MODULOS = ['agenda'] as const
export type Modulo = (typeof MODULOS)[number]
export const ehModulo = (v: unknown): v is Modulo => typeof v === 'string' && (MODULOS as readonly string[]).includes(v)

export const RETENCAO_MIN_MESES = 6
export const RETENCAO_MAX_MESES = 120
export const RETENCAO_PADRAO_MESES = 12

export interface EnderecoEmpresa {
  readonly cep: string; readonly logradouro: string; readonly numero: string; readonly complemento: string
  readonly bairro: string; readonly cidade: string; readonly uf: string
}

/** Valores NORMALIZADOS (o que vai ao banco). */
export interface EmpresaContatoLgpd {
  nome: string
  fuso: string
  cnpj: string | null
  telefone: string | null
  whatsapp: string | null
  email: string | null
  site: string | null
  endereco: EnderecoEmpresa | null
  dpoNome: string | null
  dpoEmail: string | null
  retencaoMeses: number
  textoConsentimento: string | null
  exigirConsentimentoWhatsapp: boolean
}

export type CorpoEmpresa = { readonly [K in keyof EmpresaContatoLgpd]?: unknown }
export type ErrosEmpresa = Partial<Record<keyof EmpresaContatoLgpd | `endereco.${keyof EnderecoEmpresa}`, string>>

export type ResultadoEmpresa =
  | { readonly ok: true; readonly valores: Partial<EmpresaContatoLgpd> }
  | { readonly ok: false; readonly campos: ErrosEmpresa }

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const URL_HTTPS = /^https:\/\/[^\s/$.?#][^\s]*$/i

const texto = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** Telefone BR: 10 ou 11 dígitos (DDD + número), com 55 opcional na frente. */
export function telefoneValido(bruto: string): boolean {
  let d = apenasDigitos(bruto)
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2)
  return d.length === 10 || d.length === 11
}

/**
 * Valida o corpo do PATCH. `fusoValido` vem de quem chama (a checagem IANA usa
 * `Intl`, que o shared não assume).
 */
export function validarEmpresa(corpo: CorpoEmpresa | undefined, fusoValido: (f: string) => boolean = () => true): ResultadoEmpresa {
  const b = corpo ?? {}
  const campos: ErrosEmpresa = {}
  const valores: Partial<EmpresaContatoLgpd> = {}
  const tem = (k: keyof EmpresaContatoLgpd) => Object.prototype.hasOwnProperty.call(b, k) && b[k] !== undefined

  if (tem('nome')) {
    const v = texto(b.nome)
    if (!v) campos.nome = 'O nome não pode ficar vazio.'
    else if (v.length > 120) campos.nome = 'O nome tem no máximo 120 caracteres.'
    else valores.nome = v
  }
  if (tem('fuso')) {
    const v = texto(b.fuso)
    if (!v || !fusoValido(v)) campos.fuso = `Fuso "${v}" não existe. Use um fuso IANA, por exemplo America/Sao_Paulo.`
    else valores.fuso = v
  }
  if (tem('cnpj')) {
    const v = apenasDigitos(texto(b.cnpj))
    if (!v) valores.cnpj = null
    else if (!validarCnpj(v)) campos.cnpj = 'CNPJ inválido. Confira os dígitos.'
    else valores.cnpj = v
  }
  for (const k of ['telefone', 'whatsapp'] as const) {
    if (!tem(k)) continue
    const v = texto(b[k])
    if (!v) valores[k] = null
    else if (!telefoneValido(v)) campos[k] = 'Informe o DDD e o número, com 10 ou 11 dígitos.'
    else valores[k] = apenasDigitos(v)
  }
  for (const k of ['email', 'dpoEmail'] as const) {
    if (!tem(k)) continue
    const v = texto(b[k]).toLowerCase()
    if (!v) valores[k] = null
    else if (!EMAIL.test(v) || v.length > 200) campos[k] = 'Informe um e-mail válido.'
    else valores[k] = v
  }
  if (tem('site')) {
    const v = texto(b.site)
    if (!v) valores.site = null
    else if (!URL_HTTPS.test(v) || v.length > 300) campos.site = 'Informe um endereço começando com https://.'
    else valores.site = v
  }
  if (tem('dpoNome')) {
    const v = texto(b.dpoNome)
    if (v.length > 120) campos.dpoNome = 'O nome tem no máximo 120 caracteres.'
    else valores.dpoNome = v || null
  }
  if (tem('textoConsentimento')) {
    const v = texto(b.textoConsentimento)
    if (v.length > 1000) campos.textoConsentimento = 'O texto tem no máximo 1000 caracteres.'
    else valores.textoConsentimento = v || null
  }
  if (tem('retencaoMeses')) {
    const n = b.retencaoMeses
    if (typeof n !== 'number' || !Number.isInteger(n) || n < RETENCAO_MIN_MESES || n > RETENCAO_MAX_MESES) {
      campos.retencaoMeses = `Informe de ${RETENCAO_MIN_MESES} a ${RETENCAO_MAX_MESES} meses.`
    } else valores.retencaoMeses = n
  }
  if (tem('exigirConsentimentoWhatsapp')) {
    if (typeof b.exigirConsentimentoWhatsapp !== 'boolean') campos.exigirConsentimentoWhatsapp = 'Informe sim ou não.'
    else valores.exigirConsentimentoWhatsapp = b.exigirConsentimentoWhatsapp
  }
  if (tem('endereco')) validarEndereco(b.endereco, campos, valores)

  return Object.keys(campos).length > 0 ? { ok: false, campos } : { ok: true, valores }
}

function validarEndereco(bruto: unknown, campos: ErrosEmpresa, valores: Partial<EmpresaContatoLgpd>): void {
  if (bruto === null) { valores.endereco = null; return }
  if (typeof bruto !== 'object' || Array.isArray(bruto)) { campos['endereco.cep'] = 'Endereço inválido.'; return }
  const e = bruto as Record<string, unknown>
  const cep = apenasDigitos(texto(e.cep))
  const uf = texto(e.uf).toUpperCase()
  const fim: EnderecoEmpresa = {
    cep, logradouro: texto(e.logradouro), numero: texto(e.numero), complemento: texto(e.complemento),
    bairro: texto(e.bairro), cidade: texto(e.cidade), uf,
  }
  if (Object.values(fim).every((v) => v === '')) { valores.endereco = null; return }
  const erros: ErrosEmpresa = {}
  if (cep && cep.length !== 8) erros['endereco.cep'] = 'O CEP tem 8 dígitos.'
  if (uf && !(UFS as readonly string[]).includes(uf)) erros['endereco.uf'] = 'UF inválida.'
  for (const k of ['logradouro', 'numero', 'complemento', 'bairro', 'cidade'] as const) {
    if (fim[k].length > 120) erros[`endereco.${k}`] = 'No máximo 120 caracteres.'
  }
  if (Object.keys(erros).length > 0) Object.assign(campos, erros)
  else valores.endereco = fim
}
