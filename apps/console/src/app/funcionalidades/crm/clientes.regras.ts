import {
  CODIGOS_SEGMENTO_RFV, LIMITE_ACAO_EM_MASSA, MAX_ETIQUETAS_NO_FILTRO, QUALIFICACOES_CONTATO, ROTULO_QUALIFICACAO, VENDEDOR_SEM_DONO,
  ehCodigoSegmentoRfv, ehQualificacaoContato, rotuloSegmento,
  type AcaoEmMassaContato, type QualificacaoContato,
} from '@geracrm/shared'
import type { OpcaoSelect } from '../../compartilhado/ui/index.js'
import { venceEmIso } from './tarefas.regras.js'

/**
 * Regras puras da lista de Contatos (A2): filtros ↔ query params (a URL é a fonte do
 * estado, para o link ser compartilhável), montagem do corpo de cada ação em massa e
 * quais ações cada papel enxerga. Sem DOM, sem HTTP — testável em node.
 */

export interface FiltrosContatos {
  readonly q: string
  readonly qualificacao: string
  readonly segmento: string
  readonly vendedorId: string
  readonly filialId: string
  readonly origemId: string
  readonly etiquetaIds: readonly string[]
  readonly semProximoPasso: boolean
  readonly criadoDe: string
  readonly criadoAte: string
}

export const FILTROS_CONTATOS_VAZIOS: FiltrosContatos = {
  q: '', qualificacao: '', segmento: '', vendedorId: '', filialId: '', origemId: '',
  etiquetaIds: [], semProximoPasso: false, criadoDe: '', criadoAte: '',
}

export type QueryContatos = Record<string, string | string[]>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DIA = /^\d{4}-\d{2}-\d{2}$/

const unico = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? '') : (v ?? ''))
const uuidOuVazio = (v: string): string => (UUID.test(v) ? v : '')
const diaOuVazio = (v: string): string => (DIA.test(v) ? v : '')

/**
 * Lê os filtros da query da URL. Valor que a API recusaria é descartado aqui (o link
 * adulterado cai em "sem filtro" em vez de um 422 na tela).
 */
export function filtrosDaQuery(query: QueryContatos): FiltrosContatos {
  const etiquetas = ([] as string[]).concat(query['etiquetaId'] ?? []).filter((e) => UUID.test(e))
  const vendedor = unico(query['vendedorId'])
  return {
    q: unico(query['q']).trim(),
    qualificacao: ehQualificacaoContato(unico(query['qualificacao'])) ? unico(query['qualificacao']) : '',
    segmento: ehCodigoSegmentoRfv(unico(query['segmento'])) ? unico(query['segmento']) : '',
    vendedorId: vendedor === VENDEDOR_SEM_DONO ? vendedor : uuidOuVazio(vendedor),
    filialId: uuidOuVazio(unico(query['filialId'])),
    origemId: uuidOuVazio(unico(query['origemId'])),
    etiquetaIds: [...new Set(etiquetas)].slice(0, MAX_ETIQUETAS_NO_FILTRO),
    semProximoPasso: unico(query['semProximoPasso']) === 'true',
    criadoDe: diaOuVazio(unico(query['criadoDe'])),
    criadoAte: diaOuVazio(unico(query['criadoAte'])),
  }
}

/** Query da URL do navegador a partir dos filtros: só o que está preenchido. */
export function queryDosFiltros(f: FiltrosContatos): QueryContatos {
  const q: QueryContatos = {}
  if (f.q) q['q'] = f.q
  if (f.qualificacao) q['qualificacao'] = f.qualificacao
  if (f.segmento) q['segmento'] = f.segmento
  if (f.vendedorId) q['vendedorId'] = f.vendedorId
  if (f.filialId) q['filialId'] = f.filialId
  if (f.origemId) q['origemId'] = f.origemId
  if (f.etiquetaIds.length > 0) q['etiquetaId'] = [...f.etiquetaIds]
  if (f.semProximoPasso) q['semProximoPasso'] = 'true'
  if (f.criadoDe) q['criadoDe'] = f.criadoDe
  if (f.criadoAte) q['criadoAte'] = f.criadoAte
  return q
}

/** Texto da querystring de `GET /v1/contatos` (etiquetaId se repete). */
export function paramsDaApi(f: FiltrosContatos, cursor: string | null, limite = 30): string {
  const p = new URLSearchParams({ limite: String(limite) })
  if (cursor) p.set('cursor', cursor)
  for (const [k, v] of Object.entries(queryDosFiltros(f))) {
    for (const x of ([] as string[]).concat(v)) p.append(k, x)
  }
  return p.toString()
}

export function temFiltroAtivo(f: FiltrosContatos): boolean {
  return Object.keys(queryDosFiltros(f)).length > 0
}

/** Período invertido: a API responderia 422. */
export const periodoInvalido = (f: FiltrosContatos): boolean =>
  f.criadoDe !== '' && f.criadoAte !== '' && f.criadoDe > f.criadoAte

export const OPCOES_QUALIFICACAO: OpcaoSelect[] =
  QUALIFICACOES_CONTATO.map((q) => ({ valor: q, rotulo: ROTULO_QUALIFICACAO[q] }))

export const OPCOES_SEGMENTO: OpcaoSelect[] =
  CODIGOS_SEGMENTO_RFV.map((c) => ({ valor: c, rotulo: rotuloSegmento(c) }))

export const OPCAO_SEM_DONO: OpcaoSelect = { valor: VENDEDOR_SEM_DONO, rotulo: 'Sem dono' }

export const rotuloQualificacao = (q: string): string => ROTULO_QUALIFICACAO[q as QualificacaoContato] ?? q

/** Tom do badge de qualificação. */
export function tomQualificacao(q: string): 'neutro' | 'sucesso' | 'erro' {
  return q === 'qualificado' ? 'sucesso' : q === 'descartado' ? 'erro' : 'neutro'
}

// ───────────────────────────── ações em massa ─────────────────────────────

export interface AcaoDoLote { readonly acao: AcaoEmMassaContato; readonly rotulo: string; readonly soGestao: boolean }

/** Todas as ações da faixa, na ordem em que aparecem. */
const ACOES_DO_LOTE: readonly AcaoDoLote[] = [
  { acao: 'qualificar', rotulo: 'Qualificar', soGestao: false },
  { acao: 'descartar', rotulo: 'Descartar', soGestao: false },
  { acao: 'reabrir', rotulo: 'Reabrir', soGestao: false },
  { acao: 'transferir', rotulo: 'Transferir', soGestao: true },
  { acao: 'etiquetar', rotulo: 'Etiquetar', soGestao: false },
  { acao: 'adicionar-lista', rotulo: 'Adicionar à lista', soGestao: false },
  { acao: 'criar-tarefa', rotulo: 'Criar tarefa', soGestao: true },
]

/** Quais ações o papel enxerga: transferir e criar tarefa só para a gestão (a API revalida). */
export function acoesVisiveis(gestao: boolean): readonly AcaoDoLote[] {
  return ACOES_DO_LOTE.filter((a) => gestao || !a.soGestao)
}

/** Seleção → ids para a API: únicos e dentro do teto (o excedente nunca é enviado em silêncio). */
export function idsDoLote(selecionados: ReadonlySet<string>): { ids: string[]; excedeu: boolean } {
  const todos = [...selecionados]
  return { ids: todos.slice(0, LIMITE_ACAO_EM_MASSA), excedeu: todos.length > LIMITE_ACAO_EM_MASSA }
}

export interface FormAcao {
  readonly motivo: string
  readonly observacao: string
  readonly usuarioId: string
  readonly etiquetaIds: readonly string[]
  readonly listaId: string
  readonly titulo: string
  readonly tipo: string
  readonly data: string
  readonly hora: string
  readonly responsavelId: string
  readonly descricao: string
}

export const FORM_ACAO_VAZIO: FormAcao = {
  motivo: '', observacao: '', usuarioId: '', etiquetaIds: [], listaId: '',
  titulo: '', tipo: 'outro', data: '', hora: '09:00', responsavelId: '', descricao: '',
}

export type ErrosAcao = Partial<Record<'motivo' | 'observacao' | 'usuarioId' | 'etiquetaIds' | 'listaId' | 'titulo' | 'data' | 'hora', string>>

/** Erros por campo do formulário de cada ação (a API continua sendo a regra). */
export function validarAcao(acao: AcaoEmMassaContato, f: FormAcao): ErrosAcao {
  const e: Record<string, string> = {}
  if (acao === 'descartar') {
    if (!f.motivo) e['motivo'] = 'Escolha o motivo.'
    if (!f.observacao.trim()) e['observacao'] = 'Escreva a observação.'
    else if (f.observacao.trim().length > 1000) e['observacao'] = 'Use até 1000 caracteres.'
  }
  if (acao === 'transferir') {
    if (!f.usuarioId) e['usuarioId'] = 'Escolha o novo vendedor.'
    if (!f.motivo.trim()) e['motivo'] = 'Informe o motivo da transferência.'
  }
  if ((acao === 'etiquetar' || acao === 'desetiquetar') && f.etiquetaIds.length === 0) e['etiquetaIds'] = 'Escolha ao menos uma etiqueta.'
  if (acao === 'adicionar-lista' && !f.listaId) e['listaId'] = 'Escolha a lista.'
  if (acao === 'criar-tarefa') {
    if (!f.titulo.trim()) e['titulo'] = 'Dê um título.'
    else if (f.titulo.trim().length > 200) e['titulo'] = 'Use até 200 caracteres.'
    if (!f.data) e['data'] = 'Informe a data.'
    if (!f.hora) e['hora'] = 'Informe a hora.'
  }
  return e
}

/**
 * Corpo de `POST /v1/contatos/acoes-em-massa/:acao`. null = o formulário ainda não vale
 * (a tela mostra os erros de `validarAcao`). Nunca carrega preço nem tenant.
 */
export function corpoDaAcao(acao: AcaoEmMassaContato, contatoIds: readonly string[], f: FormAcao): Record<string, unknown> | null {
  if (contatoIds.length === 0) return null
  const base = { contatoIds: [...contatoIds] }
  switch (acao) {
    case 'qualificar':
    case 'reabrir':
      return base
    case 'descartar':
      return f.motivo && f.observacao.trim() ? { ...base, motivo: f.motivo, observacao: f.observacao.trim() } : null
    case 'transferir':
      return f.usuarioId && f.motivo.trim() ? { ...base, usuarioId: f.usuarioId, motivo: f.motivo.trim() } : null
    case 'etiquetar':
    case 'desetiquetar':
      return f.etiquetaIds.length > 0 ? { ...base, etiquetaIds: [...f.etiquetaIds] } : null
    case 'adicionar-lista':
      return f.listaId ? { ...base, listaId: f.listaId } : null
    case 'criar-tarefa': {
      const venceEm = venceEmIso(f.data, f.hora)
      if (!venceEm || !f.titulo.trim()) return null
      return {
        ...base, titulo: f.titulo.trim(), venceEm, tipo: f.tipo || 'outro',
        ...(f.responsavelId ? { responsavelId: f.responsavelId } : {}),
        ...(f.descricao.trim() ? { descricao: f.descricao.trim() } : {}),
      }
    }
  }
}

/** Frase do resultado: o que foi feito e quantos ficaram de fora (sem dizer quais). */
export function textoResultadoAcao(r: { aplicados: number; ignorados: number }): string {
  const n = (x: number, um: string, varios: string): string => (x === 1 ? `1 ${um}` : `${x.toLocaleString('pt-BR')} ${varios}`)
  const feito = r.aplicados === 0 ? 'Nenhum contato foi alterado' : `${n(r.aplicados, 'contato alterado', 'contatos alterados')}`
  return r.ignorados > 0 ? `${feito}; ${n(r.ignorados, 'ficou', 'ficaram')} de fora (sem acesso ou sem mudança).` : `${feito}.`
}

/** Título do modal de cada ação. */
export const TITULO_ACAO: Readonly<Record<AcaoEmMassaContato, string>> = {
  qualificar: 'Qualificar contatos',
  descartar: 'Descartar contatos',
  reabrir: 'Reabrir contatos',
  transferir: 'Transferir contatos',
  etiquetar: 'Etiquetar contatos',
  desetiquetar: 'Remover etiqueta',
  'adicionar-lista': 'Adicionar à lista',
  'criar-tarefa': 'Criar tarefa para os contatos',
}

/** Ações que não pedem formulário: confirmação simples. */
export const ACAO_SEM_FORMULARIO = (acao: AcaoEmMassaContato): boolean => acao === 'qualificar' || acao === 'reabrir'
