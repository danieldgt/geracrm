import {
  RETENCAO_PADRAO_MESES, validarEmpresa, type CorpoEmpresa, type EmpresaContatoLgpd, type ErrosEmpresa,
} from '@geracrm/shared'
import { formatarCep, formatarCnpj, formatarTelefone, soDigitos } from '../../compartilhado/ui/mascaras.js'

/**
 * D5 — contato da empresa e LGPD. Regras PURAS (sem Angular): a tela só liga
 * signals a elas. A validação é a MESMA de `@geracrm/shared` (a API é a regra;
 * aqui é conveniência para não gastar uma ida ao servidor).
 */

export type EmpresaLida = EmpresaContatoLgpd & { readonly plano: string }
export type ErrosForm = Readonly<Record<string, string>>

export interface EmpresaForm {
  nome: string; fuso: string; cnpj: string; telefone: string; whatsapp: string; email: string; site: string
  cep: string; logradouro: string; numero: string; complemento: string; bairro: string; cidade: string; uf: string
}

export interface LgpdForm {
  dpoNome: string; dpoEmail: string; retencaoMeses: string; textoConsentimento: string
  exigirConsentimentoWhatsapp: boolean
}

export const FORM_LGPD_VAZIO: LgpdForm = {
  dpoNome: '', dpoEmail: '', retencaoMeses: String(RETENCAO_PADRAO_MESES), textoConsentimento: '',
  exigirConsentimentoWhatsapp: false,
}

/** Dos dados da API para o que a tela edita (máscara aplicada; ausente vira texto vazio). */
export function formDaEmpresa(e: EmpresaLida): EmpresaForm {
  const a = e.endereco
  return {
    nome: e.nome, fuso: e.fuso, cnpj: formatarCnpj(e.cnpj ?? ''), telefone: formatarTelefone(e.telefone ?? ''),
    whatsapp: formatarTelefone(e.whatsapp ?? ''), email: e.email ?? '', site: e.site ?? '',
    cep: formatarCep(a?.cep ?? ''), logradouro: a?.logradouro ?? '', numero: a?.numero ?? '',
    complemento: a?.complemento ?? '', bairro: a?.bairro ?? '', cidade: a?.cidade ?? '', uf: a?.uf ?? '',
  }
}

export function formDaLgpd(e: EmpresaLida): LgpdForm {
  return {
    dpoNome: e.dpoNome ?? '', dpoEmail: e.dpoEmail ?? '', retencaoMeses: String(e.retencaoMeses),
    textoConsentimento: e.textoConsentimento ?? '', exigirConsentimentoWhatsapp: e.exigirConsentimentoWhatsapp,
  }
}

/** Corpo do PATCH do painel Empresa. Documento e telefones vão como dígitos; o servidor normaliza de novo. */
export function corpoDaEmpresa(f: EmpresaForm): CorpoEmpresa {
  return {
    nome: f.nome.trim(), fuso: f.fuso, cnpj: soDigitos(f.cnpj), telefone: soDigitos(f.telefone),
    whatsapp: soDigitos(f.whatsapp), email: f.email.trim(), site: f.site.trim(),
    endereco: {
      cep: soDigitos(f.cep), logradouro: f.logradouro, numero: f.numero, complemento: f.complemento,
      bairro: f.bairro, cidade: f.cidade, uf: f.uf,
    },
  }
}

/** Retenção digitada → inteiro; texto que não é inteiro vai como NaN e a validação recusa. */
function mesesDe(texto: string): number {
  const t = texto.trim()
  return /^\d+$/.test(t) ? Number(t) : Number.NaN
}

/** Corpo do PATCH do painel LGPD. */
export function corpoDaLgpd(f: LgpdForm): CorpoEmpresa {
  return {
    dpoNome: f.dpoNome.trim(), dpoEmail: f.dpoEmail.trim(), retencaoMeses: mesesDe(f.retencaoMeses),
    textoConsentimento: f.textoConsentimento.trim(), exigirConsentimentoWhatsapp: f.exigirConsentimentoWhatsapp,
  }
}

/** Erros por campo (chave = nome do campo da API; `endereco.cep` para o endereço). Vazio = pode enviar. */
export function errosDoCorpo(corpo: CorpoEmpresa): ErrosForm {
  const r = validarEmpresa(corpo)
  return r.ok ? {} : (r.campos as ErrosEmpresa)
}

/** O 422 `{erro:'validacao', campos}` da API, ou null se não for esse formato. */
export function errosDoServidor(e: unknown): ErrosForm | null {
  if (!e || typeof e !== 'object') return null
  const { status, error } = e as { status?: unknown; error?: unknown }
  if (status !== 422 || !error || typeof error !== 'object') return null
  const campos = (error as { campos?: unknown }).campos
  if (!campos || typeof campos !== 'object' || Array.isArray(campos)) return null
  const saida: Record<string, string> = {}
  for (const [k, v] of Object.entries(campos)) if (typeof v === 'string') saida[k] = v
  return Object.keys(saida).length > 0 ? saida : null
}

/** Texto único para o toast quando há erro por campo. */
export function resumoDosErros(erros: ErrosForm): string {
  const n = Object.keys(erros).length
  return n === 1 ? 'Corrija o campo destacado.' : `Corrija os ${n} campos destacados.`
}

/** Só admin altera; o resto vê em leitura (a API barra com 403 de qualquer forma). */
export function somenteLeitura(admin: boolean | null): boolean { return admin !== true }
