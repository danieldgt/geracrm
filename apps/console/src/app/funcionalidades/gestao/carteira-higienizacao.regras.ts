import {
  META_PROXIMO_PASSO, VENDEDOR_SEM_DONO, estadoContraMeta, faltamParaMeta,
  type AcaoEmMassaContato, type AgrupamentoCockpit, type EstadoContraMeta, type GrupoIndicadorCarteira, type IndicadorCarteira,
} from '@geracrm/shared'
import type { TomStat } from '../../compartilhado/ui/stat-card.componente.js'
import type { ColunaTabela } from '../../compartilhado/ui/tabela.componente.js'
import { FILTROS_CONTATOS_VAZIOS, type FiltrosContatos } from '../crm/clientes.regras.js'

/** Regras puras da Higienização da carteira (D2), sem Angular: meta, estado, filtros da lista e do indicador. */

export const ROTULO_ESTADO_META: Readonly<Record<EstadoContraMeta, string>> = {
  atingida: 'Meta atingida', atencao: 'Perto da meta', critica: 'Longe da meta',
}

/** Cor sempre acompanhada do rótulo acima — nunca só cor. */
export const TOM_ESTADO_META: Readonly<Record<EstadoContraMeta, TomStat>> = {
  atingida: 'sucesso', atencao: 'atencao', critica: 'erro',
}

/** Largura da barra de progresso (0–100), limitada. */
export function larguraDaBarra(percentual: number): number {
  if (!Number.isFinite(percentual)) return 0
  return Math.min(100, Math.max(0, percentual))
}

/** "Faltam 12 contatos com próximo passo para chegar a 95%" ou a confirmação de que a meta foi atingida. */
export function textoDaMeta(i: IndicadorCarteira): string {
  if (i.ativos === 0) return 'Nenhum contato ativo na carteira (qualificado ou em funil).'
  const falta = faltamParaMeta(i.ativos, i.comProximoPasso, i.meta)
  if (falta === 0) return `Meta de ${i.meta}% atingida.`
  return `Faltam ${falta.toLocaleString('pt-BR')} ${falta === 1 ? 'contato' : 'contatos'} com próximo passo para chegar a ${i.meta}%.`
}

export function estadoDoIndicador(i: IndicadorCarteira): EstadoContraMeta {
  return estadoContraMeta(i.percentual, i.meta)
}

export const formatarPercentual = (p: number): string => `${p.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`

export { META_PROXIMO_PASSO }

// ── filtros ──

/** O recorte da tela: quem é do grupo escolhido (vendedor OU filial). */
export interface RecorteCarteira { readonly vendedorId: string; readonly filialId: string }
export const RECORTE_VAZIO: RecorteCarteira = { vendedorId: '', filialId: '' }

/** Filtros da lista: SEMPRE carteira ativa sem próximo passo (o mesmo conjunto do indicador) + o recorte. */
export function filtrosDaLista(r: RecorteCarteira): FiltrosContatos {
  return { ...FILTROS_CONTATOS_VAZIOS, semProximoPasso: true, carteiraAtiva: true, vendedorId: r.vendedorId, filialId: r.filialId }
}

/** Querystring do indicador e dos grupos: só filial/vendedor valem para a API. */
export function queryDoIndicador(r: RecorteCarteira, agrupar?: AgrupamentoCockpit): string {
  const q = new URLSearchParams()
  if (agrupar) q.set('agrupar', agrupar)
  if (r.vendedorId) q.set('vendedorId', r.vendedorId)
  if (r.filialId) q.set('filialId', r.filialId)
  return q.toString()
}

/** Clicar num grupo filtra por ele; o grupo "sem filial" não tem filtro na lista (null). */
export function recorteDoGrupo(agrupar: AgrupamentoCockpit, chave: string): RecorteCarteira | null {
  if (agrupar === 'vendedor') return { vendedorId: chave === 'sem' ? VENDEDOR_SEM_DONO : chave, filialId: '' }
  return chave === 'sem' ? null : { vendedorId: '', filialId: chave }
}

export function recorteAtivo(r: RecorteCarteira): boolean {
  return r.vendedorId !== '' || r.filialId !== ''
}

/** O grupo da tabela está selecionado no recorte atual? */
export function grupoSelecionado(agrupar: AgrupamentoCockpit, chave: string, r: RecorteCarteira): boolean {
  const g = recorteDoGrupo(agrupar, chave)
  return g !== null && g.vendedorId === r.vendedorId && g.filialId === r.filialId
}

/** Recorte vindo da URL (atalho do Cockpit): só uuid ou "sem-dono" passam. */
export function recorteDaQuery(query: Readonly<Record<string, string | undefined>>): RecorteCarteira {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const v = query['vendedorId'] ?? ''
  const f = query['filialId'] ?? ''
  return { vendedorId: v === VENDEDOR_SEM_DONO || uuid.test(v) ? v : '', filialId: uuid.test(f) ? f : '' }
}

// ── tabela por grupo ──

export const colunasDosGruposCarteira = (rotuloGrupo: string): readonly ColunaTabela[] => [
  { chave: 'rotulo', rotulo: rotuloGrupo },
  { chave: 'percentual', rotulo: 'Com próximo passo', alinhamento: 'dir', mono: true },
  { chave: 'semProximoPasso', rotulo: 'Sem próximo passo', alinhamento: 'dir', mono: true },
  { chave: 'ativos', rotulo: 'Ativos', alinhamento: 'dir', mono: true },
]

export interface LinhaGrupoCarteira extends Record<string, unknown> {
  readonly chave: string
  readonly rotulo: string
  readonly percentual: number
  readonly semProximoPasso: number
  readonly ativos: number
  readonly estado: EstadoContraMeta
}

export function linhasDosGruposCarteira(grupos: readonly GrupoIndicadorCarteira[]): readonly LinhaGrupoCarteira[] {
  return grupos.map((g) => ({
    chave: g.chave, rotulo: g.rotulo, percentual: g.percentual, semProximoPasso: g.semProximoPasso, ativos: g.ativos,
    estado: estadoContraMeta(g.percentual, g.meta),
  }))
}

// ── ações em lote ──

export const ACOES_HIGIENIZACAO: readonly { acao: AcaoEmMassaContato; rotulo: string }[] = [
  { acao: 'criar-tarefa', rotulo: 'Criar tarefa' },
  { acao: 'descartar', rotulo: 'Descartar' },
  { acao: 'transferir', rotulo: 'Transferir' },
]
