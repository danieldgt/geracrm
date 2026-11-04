import { queryDeLista } from '../../compartilhado/ui/cursor.js'
import type { ColunaCsv } from '../../compartilhado/ui/csv.js'
import type { ItemDefinicao } from '../../compartilhado/ui/lista-definicao.componente.js'

// Funções puras da tela de auditoria. O vitest do console roda em node (sem DOM):
// nada de Angular aqui, só tipos e utilidades.

/** Uma entrada do rastro (EP-07). `dados` é o contexto/diff da ação. */
export interface EntradaAuditoria {
  readonly id: string
  readonly criadoEm: string
  readonly acao: string
  readonly entidade: string
  readonly entidadeId: string | null
  readonly atorNome: string | null
  readonly dados: unknown
}

/** Filtros da tela. Strings vazias = "sem filtro". Datas em yyyy-mm-dd, no fuso local. */
export interface FiltroAuditoria {
  readonly busca: string
  readonly acao: string
  readonly atorId: string
  readonly inicio: string
  readonly fim: string
}

export const FILTRO_VAZIO: FiltroAuditoria = { busca: '', acao: '', atorId: '', inicio: '', fim: '' }

/** Mesmo limite do servidor (`q` ≤ 80). */
export const TAMANHO_BUSCA_MAX = 80

/** Ações que o rastro já rotula na tela. Outras aparecem pelo código cru. */
export const ACOES_AUDITORIA: readonly { readonly valor: string; readonly rotulo: string }[] = [
  { valor: 'atendimento.assumido', rotulo: 'Assumiu o atendimento' },
  { valor: 'mensagem.apagada', rotulo: 'Apagou uma mensagem' },
  { valor: 'mensagem.editada', rotulo: 'Editou uma mensagem' },
  { valor: 'usuario.login', rotulo: 'Entrou no sistema' },
  { valor: 'usuario.logout', rotulo: 'Saiu do sistema' },
  { valor: 'usuario.senha_alterada', rotulo: 'Trocou a própria senha' },
  { valor: 'usuario.senha_redefinida', rotulo: 'Redefiniu a senha por código' },
  { valor: 'usuario.perfil_alterado', rotulo: 'Alterou o próprio perfil' },
  { valor: 'usuario.foto_alterada', rotulo: 'Alterou a própria foto' },
]

/** ⚠️ Rótulo no vocabulário da operação, não o código cru do evento. */
export function rotuloAcao(acao: string): string {
  return ACOES_AUDITORIA.find((a) => a.valor === acao)?.rotulo ?? acao
}

/** Detalhe curto da linha: o que mais importa daquela ação, lido de `dados`. */
export function detalheDoEvento(acao: string, dados: unknown): string {
  const d = dados && typeof dados === 'object' ? (dados as Record<string, unknown>) : null
  if (!d) return ''
  if (acao === 'atendimento.assumido' && 'protocolo' in d) return `Protocolo #${String(d['protocolo'])}`
  if (acao === 'mensagem.apagada') return d['paraTodos'] ? 'Para todos' : 'Só para mim'
  return ''
}

/** Quem fez: nome do ator, ou "Sistema" quando a ação não tem ator. */
export const quemDoEvento = (e: Pick<EntradaAuditoria, 'atorNome'>): string => e.atorNome ?? 'Sistema'

/**
 * Data/hora local. A fração chega com até 6 dígitos (precisão do banco); o `Date`
 * só aceita milissegundos, então a fração extra sai antes de parsear.
 */
export function formatarQuando(iso: string, comSegundos = false): string {
  const d = new Date(iso.replace(/(\.\d{3})\d+/, '$1'))
  if (Number.isNaN(d.getTime())) return iso
  const z = (n: number): string => String(n).padStart(2, '0')
  const base = `${z(d.getDate())}/${z(d.getMonth() + 1)}/${d.getFullYear()} ${z(d.getHours())}:${z(d.getMinutes())}`
  return comSegundos ? `${base}:${z(d.getSeconds())}` : base
}

/**
 * Intervalo do filtro em ISO com fuso. `inicio` = meia-noite local do primeiro dia;
 * `fim` vira `ate` EXCLUSIVO = meia-noite do dia seguinte, para o último dia entrar inteiro.
 */
export function intervaloIso(inicio: string, fim: string): { de: string | null; ate: string | null } {
  return {
    de: inicio ? meiaNoiteLocal(inicio, 0).toISOString() : null,
    ate: fim ? meiaNoiteLocal(fim, 1).toISOString() : null,
  }
}

function meiaNoiteLocal(isoDia: string, somarDias: number): Date {
  const [a = 1970, m = 1, d = 1] = isoDia.split('-').map(Number)
  return new Date(a, m - 1, d + somarDias)
}

/**
 * Query da lista: filtros + cursor. Vazio some (queryDeLista omite). A busca é aparada
 * e cortada no limite do servidor, para o usuário nunca levar 422 por digitar demais.
 */
export function montarQueryAuditoria(f: FiltroAuditoria, cursor: string | null = null): string {
  const periodo = intervaloIso(f.inicio, f.fim)
  return queryDeLista({
    cursor,
    q: f.busca.trim().slice(0, TAMANHO_BUSCA_MAX),
    acao: f.acao,
    atorId: f.atorId,
    de: periodo.de,
    ate: periodo.ate,
  })
}

export function filtrosAtivos(f: FiltroAuditoria): boolean {
  return f.busca.trim() !== '' || f.acao !== '' || f.atorId !== '' || f.inicio !== '' || f.fim !== ''
}

/** Opções do seletor de usuário. A equipe chega ordenada por nome do servidor. */
export function opcoesDeUsuarios(membros: readonly { readonly id: string; readonly nome: string }[]): { valor: string; rotulo: string }[] {
  return membros.map((m) => ({ valor: m.id, rotulo: m.nome }))
}

/** Rótulo/valor do modal de detalhe. Vazio vira traço no componente. */
export function definicoesDoEvento(e: EntradaAuditoria): ItemDefinicao[] {
  return [
    { rotulo: 'Quando', valor: formatarQuando(e.criadoEm, true), mono: true },
    { rotulo: 'Quem', valor: quemDoEvento(e) },
    { rotulo: 'Ação', valor: rotuloAcao(e.acao) },
    { rotulo: 'Código da ação', valor: e.acao, mono: true },
    { rotulo: 'Entidade', valor: e.entidade },
    { rotulo: 'ID da entidade', valor: e.entidadeId, mono: true },
  ]
}

/** JSON completo do evento, indentado. Vai para `<pre>` como TEXTO, nunca como HTML. */
export function jsonDoEvento(dados: unknown): string {
  return JSON.stringify(dados ?? null, null, 2) ?? 'null'
}

export const COLUNAS_CSV: readonly ColunaCsv[] = [
  { chave: 'quando', rotulo: 'Quando' },
  { chave: 'quem', rotulo: 'Quem' },
  { chave: 'acao', rotulo: 'Ação' },
  { chave: 'entidade', rotulo: 'Entidade' },
  { chave: 'entidadeId', rotulo: 'ID da entidade' },
  { chave: 'detalhe', rotulo: 'Detalhe' },
]

/** Linhas do CSV: as que estão carregadas na tela, já no vocabulário da tela. */
export function linhasDoRastroCsv(itens: readonly EntradaAuditoria[]): Record<string, unknown>[] {
  return itens.map((e) => ({
    quando: formatarQuando(e.criadoEm, true),
    quem: quemDoEvento(e),
    acao: rotuloAcao(e.acao),
    entidade: e.entidade,
    entidadeId: e.entidadeId,
    detalhe: detalheDoEvento(e.acao, e.dados),
  }))
}
