/**
 * Regras PURAS do formulário de contato (montar payload, mapear erros por campo,
 * preencher pelas consultas). Sem Angular: testável em node, e a tela só liga.
 */

import type { ErroApi } from '../../compartilhado/ui/erro-http.js'

export const UFS = [
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI',
  'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO',
] as const

export const OPCOES_PRIORIDADE = [
  { valor: 'baixa', rotulo: 'Baixa' }, { valor: 'media', rotulo: 'Média' },
  { valor: 'alta', rotulo: 'Alta' }, { valor: 'urgente', rotulo: 'Urgente' },
]
export const OPCOES_TEMPERATURA = [
  { valor: 'frio', rotulo: 'Frio' }, { valor: 'morno', rotulo: 'Morno' }, { valor: 'quente', rotulo: 'Quente' },
]
export const OPCOES_MODALIDADE = [
  { valor: 'atacado', rotulo: 'Atacado' }, { valor: 'varejo', rotulo: 'Varejo' },
]

/** Valores do formulário. Texto cru dos campos; máscaras já removidas pelos `ui-campo` (só dígitos). */
export interface ValoresContatoForm {
  nome: string
  razaoSocial: string
  nomeFantasia: string
  email: string
  telefone: string
  whatsapp: boolean
  documento: string
  cep: string
  logradouro: string
  numero: string
  complemento: string
  bairro: string
  cidade: string
  uf: string
  modalidade: string
  prioridade: string
  temperatura: string
  /** Id da origem (`origem.id`); '' = sem origem. */
  origemId: string
  /** Centavos inteiros (o `ui-campo` tipo dinheiro entrega centavos). */
  valorEstimadoCentavos: number | null
  observacoes: string
}

export function formVazio(): ValoresContatoForm {
  return {
    nome: '', razaoSocial: '', nomeFantasia: '', email: '', telefone: '', whatsapp: true, documento: '',
    cep: '', logradouro: '', numero: '', complemento: '', bairro: '', cidade: '', uf: '',
    modalidade: '', prioridade: '', temperatura: '', origemId: '', valorEstimadoCentavos: null, observacoes: '',
  }
}

export interface EnderecoConsulta {
  cep: string | null; logradouro: string | null; numero: string | null; complemento: string | null
  bairro: string | null; cidade: string | null; uf: string | null
}
export interface EmpresaConsulta {
  razaoSocial: string | null; nomeFantasia: string | null; situacao: string | null; endereco: EnderecoConsulta
}

/** O que a API de cadastro espera (mesmo contrato do POST/PUT /v1/contatos). */
export interface CorpoContato {
  nome: string
  razaoSocial: string | null
  nomeFantasia: string | null
  email: string | null
  telefone: string
  whatsapp: boolean
  documento: string | null
  endereco: {
    cep: string | null; logradouro: string | null; numero: string | null; complemento: string | null
    bairro: string | null; cidade: string | null; uf: string | null
  }
  modalidade: string | null
  prioridade: string | null
  temperatura: string | null
  origemId: string | null
  valorEstimadoCentavos: number | null
  observacoes: string | null
}

const ouNulo = (v: string): string | null => (v.trim() === '' ? null : v.trim())

export function montarPayload(v: ValoresContatoForm): CorpoContato {
  return {
    nome: v.nome.trim(),
    razaoSocial: ouNulo(v.razaoSocial),
    nomeFantasia: ouNulo(v.nomeFantasia),
    email: ouNulo(v.email),
    telefone: v.telefone.trim(),
    whatsapp: v.whatsapp,
    documento: ouNulo(v.documento),
    endereco: {
      cep: ouNulo(v.cep), logradouro: ouNulo(v.logradouro), numero: ouNulo(v.numero),
      complemento: ouNulo(v.complemento), bairro: ouNulo(v.bairro), cidade: ouNulo(v.cidade),
      uf: ouNulo(v.uf)?.toUpperCase() ?? null,
    },
    modalidade: ouNulo(v.modalidade),
    prioridade: ouNulo(v.prioridade),
    temperatura: ouNulo(v.temperatura),
    origemId: ouNulo(v.origemId),
    valorEstimadoCentavos: v.valorEstimadoCentavos,
    observacoes: ouNulo(v.observacoes),
  }
}

/** Erros por campo do formulário (chave = nome do campo em `ValoresContatoForm`). */
export type ErrosForm = Partial<Record<keyof ValoresContatoForm, string>>

/** Faltas óbvias, antes de ir à API (a API é a fonte de verdade e revalida tudo). */
export function validarLocal(v: ValoresContatoForm): ErrosForm {
  const e: ErrosForm = {}
  if (!v.nome.trim()) e.nome = 'Informe o nome'
  if (!v.telefone.trim()) e.telefone = 'Informe o telefone'
  return e
}

const CAMPOS_DO_FORM: ReadonlySet<string> = new Set(Object.keys(formVazio()))

/**
 * Lê o corpo de um 422 `{erro:'validacao', campos:{campo: msg}}` e devolve só o
 * que a tela sabe pintar. Campo desconhecido não some: vai para `geral`, para
 * a tela mostrar em algum lugar em vez de engolir o erro.
 */
export function mapearErros(corpo: ErroApi | null): { campos: ErrosForm; geral: string | null } {
  const campos: ErrosForm = {}
  const extras: string[] = []
  if (corpo?.erro === 'validacao' && corpo.campos) {
    for (const [k, msg] of Object.entries(corpo.campos)) {
      if (typeof msg !== 'string') continue
      if (CAMPOS_DO_FORM.has(k)) (campos as Record<string, string>)[k] = msg
      else extras.push(msg)
    }
  }
  return { campos, geral: extras.length ? extras.join(' · ') : null }
}

/** Origem como a lista de `GET /v1/origens` devolve. */
export interface OrigemLista { readonly id: string; readonly nome: string; readonly ativa: boolean; readonly ordem: number }

/** Ordena por `ordem` e, em empate, pelo nome (pt-BR). Não muta a entrada. */
export function ordenarOrigens(itens: readonly OrigemLista[]): OrigemLista[] {
  return [...itens].sort((a, b) => a.ordem - b.ordem || a.nome.localeCompare(b.nome, 'pt-BR'))
}

/**
 * Opções do select de origem: as ativas e, na edição, a origem atual do contato
 * mesmo inativa (acrescida com " (inativa)") para a tela não abrir vazia.
 */
export function opcoesOrigem(ativas: readonly OrigemLista[], atual: OrigemLista | null): { valor: string; rotulo: string }[] {
  const jaTem = atual !== null && ativas.some((o) => o.id === atual.id)
  const lista = atual && !jaTem ? ordenarOrigens([...ativas, atual]) : [...ativas]
  return lista.map((o) => ({ valor: o.id, rotulo: o.ativa ? o.nome : `${o.nome} (inativa)` }))
}

export type StatusOrigens = 'carregando' | 'pronto' | 'erro'

export interface EstadoOrigem {
  placeholder: string
  dica: string
  desabilitado: boolean
  /** Sem origem ativa cadastrada: oferece o caminho para cadastrar. */
  linkCadastro: boolean
}

/** Estado do select de origem: carregando, falha, sem nenhuma origem ativa, ou pronto para escolher. */
export function estadoOrigem(status: StatusOrigens, quantidadeAtivas: number): EstadoOrigem {
  if (status === 'carregando') return { placeholder: 'Carregando origens…', dica: '', desabilitado: true, linkCadastro: false }
  if (status === 'erro') {
    return { placeholder: 'Origens indisponíveis', dica: 'Não foi possível carregar as origens.', desabilitado: true, linkCadastro: false }
  }
  if (quantidadeAtivas === 0) {
    return { placeholder: 'Sem origens cadastradas', dica: 'Cadastre origens em Configurações.', desabilitado: true, linkCadastro: true }
  }
  return { placeholder: 'Selecione', dica: '', desabilitado: false, linkCadastro: false }
}

const preencher = (atual: string, novo: string | null): string => (novo === null || novo === '' ? atual : novo)

/** Aplica um endereço consultado por CEP. Só sobrescreve o que veio preenchido; número/complemento são do usuário. */
export function preencherEndereco(v: ValoresContatoForm, e: EnderecoConsulta): ValoresContatoForm {
  return {
    ...v,
    cep: preencher(v.cep, e.cep),
    logradouro: preencher(v.logradouro, e.logradouro),
    bairro: preencher(v.bairro, e.bairro),
    cidade: preencher(v.cidade, e.cidade),
    uf: preencher(v.uf, e.uf),
  }
}

/**
 * Aplica a consulta de CNPJ: razão social, fantasia e endereço (a consulta é
 * pedida de propósito, então sobrescreve). O nome só é sugerido quando vazio —
 * quem digitou "Saturno" não quer ver o nome trocado pela razão social.
 */
export function preencherPelaEmpresa(v: ValoresContatoForm, emp: EmpresaConsulta): ValoresContatoForm {
  const comEndereco = preencherEndereco(v, emp.endereco)
  const sugestao = emp.nomeFantasia ?? emp.razaoSocial ?? ''
  return {
    ...comEndereco,
    razaoSocial: preencher(v.razaoSocial, emp.razaoSocial),
    nomeFantasia: preencher(v.nomeFantasia, emp.nomeFantasia),
    nome: v.nome.trim() ? v.nome : sugestao,
    numero: preencher(v.numero, emp.endereco.numero),
    complemento: preencher(v.complemento, emp.endereco.complemento),
  }
}

/** Mensagem para a falha de uma consulta externa; a tela libera o preenchimento manual. */
export function mensagemConsulta(codigo: string | null | undefined, rotulo: 'CNPJ' | 'CEP'): string {
  if (codigo === 'consulta.nao_encontrado') return `${rotulo} não encontrado. Preencha manualmente.`
  if (codigo === 'consulta.indisponivel') return 'Consulta indisponível agora. Preencha manualmente.'
  return `Não foi possível consultar o ${rotulo}. Preencha manualmente.`
}

/** CEP só pode ser consultado com 8 dígitos; CNPJ só com 14 (CPF não tem consulta pública). */
export const podeConsultarCep = (cep: string): boolean => cep.replace(/\D/g, '').length === 8
export const podeConsultarCnpj = (doc: string): boolean => doc.replace(/\D/g, '').length === 14

/** Forma da ficha (GET /v1/contatos/:id) que o formulário de edição precisa. */
export interface FichaParaForm {
  nome: string
  razaoSocial: string | null; nomeFantasia: string | null; email: string | null
  modalidade: string | null; prioridade: string | null; temperatura: string | null; origemId: string | null
  valorEstimadoCentavos: number | null; observacoes: string | null
  telefones: readonly { e164: string; principal: boolean; whatsapp: boolean }[]
  documentos: readonly { tipo: string; numero: string; fiscal: boolean }[]
  endereco: {
    cep: string | null; logradouro: string | null; numero: string | null; complemento: string | null
    bairro: string | null; cidade: string | null; uf: string | null
  } | null
}

/** Preenche o formulário a partir da ficha: telefone = o principal; documento = o fiscal (ou o primeiro). */
export function formDaFicha(f: FichaParaForm): ValoresContatoForm {
  const tel = f.telefones.find((t) => t.principal) ?? f.telefones[0]
  const doc = f.documentos.find((d) => d.fiscal) ?? f.documentos[0]
  const e = f.endereco
  return {
    nome: f.nome,
    razaoSocial: f.razaoSocial ?? '', nomeFantasia: f.nomeFantasia ?? '', email: f.email ?? '',
    telefone: tel?.e164 ?? '', whatsapp: tel?.whatsapp ?? true, documento: doc?.numero ?? '',
    cep: e?.cep ?? '', logradouro: e?.logradouro ?? '', numero: e?.numero ?? '', complemento: e?.complemento ?? '',
    bairro: e?.bairro ?? '', cidade: e?.cidade ?? '', uf: e?.uf ?? '',
    modalidade: f.modalidade ?? '', prioridade: f.prioridade ?? '', temperatura: f.temperatura ?? '',
    origemId: f.origemId ?? '',
    valorEstimadoCentavos: f.valorEstimadoCentavos, observacoes: f.observacoes ?? '',
  }
}
