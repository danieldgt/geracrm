import { CAMPOS_GANHO, dadosMinimosDoGanho, type CampoGanho } from '@geracrm/shared'
import type { EmpresaConsulta, EnderecoConsulta } from './contato-form.regras.js'

/**
 * Regras PURAS dos modais de ação do funil (ganhar, perder, transferir, nova oportunidade).
 * Sem Angular: testável em node; os componentes só ligam.
 */

export type TipoEtapa = 'aberto' | 'ganho' | 'perdido'

// ───────── O que fazer ao soltar o card ─────────

export type AcaoAoSoltar = 'reordenar' | 'mover' | 'abrir_ganho' | 'abrir_perda'

/**
 * Soltar na MESMA coluna só reordena. Em coluna de ganho/perda abre o modal (os dados e o
 * motivo são obrigatórios — nada persiste antes); em coluna aberta move direto.
 */
export function decidirAcaoAoSoltar(origemEtapaId: string, destinoEtapaId: string, destinoTipo: TipoEtapa): AcaoAoSoltar {
  if (origemEtapaId === destinoEtapaId) return 'reordenar'
  if (destinoTipo === 'ganho') return 'abrir_ganho'
  if (destinoTipo === 'perdido') return 'abrir_perda'
  return 'mover'
}

// ───────── Ganhar ─────────

export type ValoresGanho = Record<CampoGanho | 'complemento', string>
export type ErrosGanho = Partial<Record<CampoGanho, string>>

export function ganhoVazio(): ValoresGanho {
  return {
    cnpj: '', razaoSocial: '', nomeFantasia: '', cep: '', logradouro: '', numero: '', complemento: '',
    bairro: '', cidade: '', uf: '',
  }
}

/** Forma da ficha (GET /v1/contatos/:id) que o modal precisa para pré-preencher. */
export interface FichaParaGanho {
  razaoSocial: string | null
  nomeFantasia: string | null
  documentos: readonly { tipo: string; numero: string; fiscal: boolean }[]
  endereco: {
    cep: string | null; logradouro: string | null; numero: string | null; complemento: string | null
    bairro: string | null; cidade: string | null; uf: string | null
  } | null
}

/** Pré-preenche com o que o contato JÁ tem (o CNPJ fiscal primeiro; CPF não conta). */
export function ganhoDaFicha(f: FichaParaGanho): ValoresGanho {
  const cnpjs = f.documentos.filter((d) => d.tipo === 'cnpj')
  const doc = cnpjs.find((d) => d.fiscal) ?? cnpjs[0]
  const e = f.endereco
  return {
    cnpj: doc?.numero ?? '', razaoSocial: f.razaoSocial ?? '', nomeFantasia: f.nomeFantasia ?? '',
    cep: e?.cep ?? '', logradouro: e?.logradouro ?? '', numero: e?.numero ?? '', complemento: e?.complemento ?? '',
    bairro: e?.bairro ?? '', cidade: e?.cidade ?? '', uf: e?.uf ?? '',
  }
}

const ouNulo = (v: string): string | null => (v.trim() === '' ? null : v.trim())
const preencher = (atual: string, novo: string | null): string => (novo === null || novo === '' ? atual : novo)

/** Aplica a consulta de CNPJ (pedida de propósito: sobrescreve razão, fantasia e endereço). */
export function ganhoPelaEmpresa(v: ValoresGanho, emp: EmpresaConsulta): ValoresGanho {
  return { ...ganhoPeloEndereco(v, emp.endereco), razaoSocial: preencher(v.razaoSocial, emp.razaoSocial), nomeFantasia: preencher(v.nomeFantasia, emp.nomeFantasia),
    numero: preencher(v.numero, emp.endereco.numero), complemento: preencher(v.complemento, emp.endereco.complemento) }
}

/** Aplica a consulta de CEP: logradouro, bairro, cidade e UF (número e complemento são do usuário). */
export function ganhoPeloEndereco(v: ValoresGanho, e: EnderecoConsulta): ValoresGanho {
  return {
    ...v, cep: preencher(v.cep, e.cep), logradouro: preencher(v.logradouro, e.logradouro),
    bairro: preencher(v.bairro, e.bairro), cidade: preencher(v.cidade, e.cidade), uf: preencher(v.uf, e.uf),
  }
}

/** Mesma regra da API (função do shared) — conveniência: a API revalida e manda o 422 por campo. */
export function validarGanhoLocal(v: ValoresGanho): ErrosGanho {
  const r = dadosMinimosDoGanho(v)
  return r.ok ? {} : r.faltando
}

export interface CorpoGanho {
  versao: number
  pedidoId?: string
  dados: {
    cnpj: string | null; razaoSocial: string | null; nomeFantasia: string | null
    endereco: {
      cep: string | null; logradouro: string | null; numero: string | null; complemento: string | null
      bairro: string | null; cidade: string | null; uf: string | null
    }
  }
}

/** Corpo de `POST /v1/funil/oportunidades/:id/ganhar`. CNPJ e CEP vão só com dígitos; UF em maiúsculas. */
export function payloadGanho(v: ValoresGanho, versao: number, pedidoId: string): CorpoGanho {
  return {
    versao,
    ...(pedidoId ? { pedidoId } : {}),
    dados: {
      cnpj: ouNulo(v.cnpj.replace(/\D/g, '')), razaoSocial: ouNulo(v.razaoSocial), nomeFantasia: ouNulo(v.nomeFantasia),
      endereco: {
        cep: ouNulo(v.cep.replace(/\D/g, '')), logradouro: ouNulo(v.logradouro), numero: ouNulo(v.numero),
        complemento: ouNulo(v.complemento), bairro: ouNulo(v.bairro), cidade: ouNulo(v.cidade),
        uf: ouNulo(v.uf)?.toUpperCase() ?? null,
      },
    },
  }
}

const CAMPOS_GANHO_SET: ReadonlySet<string> = new Set(CAMPOS_GANHO)

/**
 * Lê o corpo de um 422 do ganho e devolve o que a tela sabe pintar: `ganho.dados_minimos` traz
 * `campos` (campo → mensagem); `ganho.pedido_invalido` vira o erro do select de pedido; o resto
 * (campo desconhecido, outro erro) vai para `geral` — nunca é engolido.
 */
export function mapearErrosGanho(corpo: unknown): { campos: ErrosGanho; pedido: string | null; geral: string | null } {
  const campos: ErrosGanho = {}
  const vazio = { campos, pedido: null, geral: null }
  if (!corpo || typeof corpo !== 'object') return vazio
  const c = corpo as { erro?: unknown; mensagem?: unknown; campos?: unknown }
  const mensagem = typeof c.mensagem === 'string' ? c.mensagem : null
  if (c.erro === 'ganho.pedido_invalido') return { campos, pedido: mensagem ?? 'Pedido inválido.', geral: null }
  if (c.erro !== 'ganho.dados_minimos') return { campos, pedido: null, geral: mensagem }
  const extras: string[] = []
  if (c.campos && typeof c.campos === 'object') {
    for (const [k, msg] of Object.entries(c.campos as Record<string, unknown>)) {
      if (typeof msg !== 'string') continue
      if (CAMPOS_GANHO_SET.has(k)) (campos as Record<string, string>)[k] = msg
      else extras.push(msg)
    }
  }
  return { campos, pedido: null, geral: extras.length ? extras.join(' · ') : null }
}

export interface PedidoDoContato { id: string; estado: string; totalCentavos: number; numeroExterno: string | null; criadoEm: string }

/** Só pedido com número no ERP (ou sob conferência) pode ser vinculado ao ganho — igual à API. */
const ESTADOS_PEDIDO_VINCULAVEIS: ReadonlySet<string> = new Set(['efetivado', 'aguardando_conferencia'])

export function pedidosVinculaveis(pedidos: readonly PedidoDoContato[]): PedidoDoContato[] {
  return pedidos.filter((p) => ESTADOS_PEDIDO_VINCULAVEIS.has(p.estado))
}

/**
 * Mescla a ficha (chegou depois) SEM sobrescrever o que o usuário já digitou: só entram os campos
 * que ele ainda não tocou.
 */
export function mesclarFicha(atual: ValoresGanho, ficha: ValoresGanho, tocados: ReadonlySet<keyof ValoresGanho>): ValoresGanho {
  const r = { ...atual }
  for (const k of Object.keys(ficha) as (keyof ValoresGanho)[]) if (!tocados.has(k)) r[k] = ficha[k]
  return r
}

const ESTADO_PEDIDO: Record<string, string> = {
  rascunho: 'Rascunho', validando: 'Validando', enviando: 'Enviando', efetivado: 'Efetivado',
  falhou: 'Falhou', aguardando_conferencia: 'Aguardando conferência',
}

/** Rótulo do pedido no select: "Pedido 1234 · Efetivado · R$ 1.500,00 · 03/11/2026". */
export function rotuloDoPedido(p: PedidoDoContato): string {
  const valor = (p.totalCentavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
  const dia = new Date(p.criadoEm).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
  const nome = p.numeroExterno ? `Pedido ${p.numeroExterno}` : 'Pedido'
  return `${nome} · ${ESTADO_PEDIDO[p.estado] ?? p.estado} · ${valor} · ${dia}`
}

// ───────── Perder ─────────

export interface FormPerda { motivoCodigo: string; descricao: string }

export function validarPerda(f: FormPerda): { motivoCodigo?: string } {
  return f.motivoCodigo.trim() ? {} : { motivoCodigo: 'Escolha o motivo da perda' }
}

export function payloadPerda(f: FormPerda, versao: number): { motivoCodigo: string; descricao?: string; versao: number } {
  const descricao = f.descricao.trim()
  return { motivoCodigo: f.motivoCodigo.trim(), ...(descricao ? { descricao } : {}), versao }
}

// ───────── Falha de ação (ganhar/perder) ─────────

export interface TratamentoFalha {
  /** Fecha o modal (o quadro já recarregou: o card mudou). */
  fechar: boolean
  /** Mensagem para toast quando o modal fecha — nunca se perde. */
  toast: string | null
  /** Mensagem a mostrar dentro do modal (aberto). */
  mensagemModal: string | null
  /** Erro do select de motivo (422 `perda.motivo_invalido`). */
  erroMotivo: string | null
}

/**
 * 409 (alguém moveu) fecha o modal e mostra a mensagem em toast; status 0 (rede) mantém o modal aberto
 * com a mensagem para tentar de novo; 422 `perda.motivo_invalido` vai para o select; o resto fica no modal.
 */
export function tratarFalhaDeAcao(status: number, corpo: unknown, mensagem: string): TratamentoFalha {
  if (status === 409) return { fechar: true, toast: mensagem, mensagemModal: null, erroMotivo: null }
  const erro = corpo && typeof corpo === 'object' ? (corpo as { erro?: unknown }).erro : null
  if (status === 422 && erro === 'perda.motivo_invalido') return { fechar: false, toast: null, mensagemModal: null, erroMotivo: mensagem }
  return { fechar: false, toast: null, mensagemModal: mensagem, erroMotivo: null }
}

// ───────── Transferir ─────────

export interface FormTransferencia { usuarioId: string; motivo: string }
export type ErrosTransferencia = Partial<Record<keyof FormTransferencia, string>>

export function validarTransferencia(f: FormTransferencia): ErrosTransferencia {
  const e: ErrosTransferencia = {}
  if (!f.usuarioId.trim()) e.usuarioId = 'Escolha o vendedor de destino'
  if (!f.motivo.trim()) e.motivo = 'Informe o motivo da transferência'
  return e
}

export const payloadTransferencia = (f: FormTransferencia): FormTransferencia =>
  ({ usuarioId: f.usuarioId.trim(), motivo: f.motivo.trim() })

// ───────── Nova oportunidade ─────────

export interface FormNovaOportunidade { contatoId: string; etapaId: string; valorCentavos: number | null }
export type ErrosNovaOportunidade = Partial<Record<'contatoId' | 'etapaId', string>>

export function validarNovaOportunidade(f: FormNovaOportunidade): ErrosNovaOportunidade {
  const e: ErrosNovaOportunidade = {}
  if (!f.contatoId.trim()) e.contatoId = 'Escolha o contato'
  if (!f.etapaId.trim()) e.etapaId = 'Escolha a etapa inicial'
  return e
}

export function payloadNovaOportunidade(f: FormNovaOportunidade): { contatoId: string; etapaId: string; valorCentavos?: number } {
  return {
    contatoId: f.contatoId.trim(), etapaId: f.etapaId.trim(),
    ...(f.valorCentavos !== null && f.valorCentavos > 0 ? { valorCentavos: f.valorCentavos } : {}),
  }
}

// ───────── Menu do card ─────────

export type AcaoDoCard = 'ganhar' | 'perder' | 'transferir' | 'tarefa' | 'ficha' | 'conversa'

export const ITENS_MENU_CARD: readonly { acao: AcaoDoCard; rotulo: string }[] = [
  { acao: 'ganhar', rotulo: 'Ganhar' },
  { acao: 'perder', rotulo: 'Perder' },
  { acao: 'transferir', rotulo: 'Transferir' },
  { acao: 'tarefa', rotulo: 'Nova tarefa' },
  { acao: 'ficha', rotulo: 'Abrir ficha' },
  { acao: 'conversa', rotulo: 'Abrir conversa' },
]

/** Cards já fechados (ganho/perdido) não oferecem Ganhar/Perder. */
export function itensDoMenu(tipoEtapa: TipoEtapa): typeof ITENS_MENU_CARD {
  return tipoEtapa === 'aberto' ? ITENS_MENU_CARD : ITENS_MENU_CARD.filter((i) => i.acao !== 'ganhar' && i.acao !== 'perder')
}

/**
 * Navegação por teclado do menu (padrão WAI-ARIA menu): ↓/↑ circulam, Home/End vão às pontas.
 * Devolve o novo índice, ou `null` quando a tecla não é de navegação.
 */
export function proximoItemDoMenu(atual: number, total: number, tecla: string): number | null {
  if (total <= 0) return null
  switch (tecla) {
    case 'ArrowDown': return atual < 0 ? 0 : (atual + 1) % total
    case 'ArrowUp': return atual < 0 ? total - 1 : (atual - 1 + total) % total
    case 'Home': return 0
    case 'End': return total - 1
    default: return null
  }
}
