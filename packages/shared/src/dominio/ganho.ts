import { apenasDigitos, validarCnpj } from './documento.js'

/**
 * Dados mínimos para GANHAR um negócio (decisão do dono): CNPJ válido, razão social,
 * nome fantasia e endereço completo (CEP, logradouro, número, bairro, cidade, UF).
 * Complemento é opcional. Puro: a API é a regra, a tela usa a mesma função como conveniência.
 */
export const CAMPOS_GANHO = [
  'cnpj', 'razaoSocial', 'nomeFantasia', 'cep', 'logradouro', 'numero', 'bairro', 'cidade', 'uf',
] as const
export type CampoGanho = (typeof CAMPOS_GANHO)[number]

export interface DadosDoGanho {
  cnpj?: string | null
  razaoSocial?: string | null
  nomeFantasia?: string | null
  cep?: string | null
  logradouro?: string | null
  numero?: string | null
  bairro?: string | null
  cidade?: string | null
  uf?: string | null
}

export type ResultadoDadosMinimos =
  | { ok: true }
  | { ok: false; faltando: Partial<Record<CampoGanho, string>> }

const vazio = (v: string | null | undefined) => !v || v.trim() === ''

export function dadosMinimosDoGanho(contato: DadosDoGanho): ResultadoDadosMinimos {
  const faltando: Partial<Record<CampoGanho, string>> = {}
  if (vazio(contato.cnpj)) faltando.cnpj = 'Informe o CNPJ'
  else if (!validarCnpj(contato.cnpj as string)) faltando.cnpj = 'CNPJ inválido'
  if (vazio(contato.razaoSocial)) faltando.razaoSocial = 'Informe a razão social'
  if (vazio(contato.nomeFantasia)) faltando.nomeFantasia = 'Informe o nome fantasia'
  if (vazio(contato.cep)) faltando.cep = 'Informe o CEP'
  else if (apenasDigitos(contato.cep as string).length !== 8) faltando.cep = 'CEP inválido'
  if (vazio(contato.logradouro)) faltando.logradouro = 'Informe o logradouro'
  if (vazio(contato.numero)) faltando.numero = 'Informe o número'
  if (vazio(contato.bairro)) faltando.bairro = 'Informe o bairro'
  if (vazio(contato.cidade)) faltando.cidade = 'Informe a cidade'
  if (vazio(contato.uf)) faltando.uf = 'Informe a UF'
  else if (!/^[A-Za-z]{2}$/.test((contato.uf as string).trim())) faltando.uf = 'UF inválida'
  return Object.keys(faltando).length === 0 ? { ok: true } : { ok: false, faltando }
}
