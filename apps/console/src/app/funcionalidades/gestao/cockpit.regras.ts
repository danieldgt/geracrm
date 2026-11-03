import {
  CARDS_COCKPIT, ROTULO_CARD_COCKPIT, duracaoCurta,
  type CardCockpit, type CardsCockpit, type FaixaAguardando, type GrupoCockpit, type ItemCockpit, type PorFaixa,
} from '@geracrm/shared'
import type { TomStat } from '../../compartilhado/ui/stat-card.componente.js'
import type { ColunaTabela } from '../../compartilhado/ui/tabela.componente.js'

/** Regras puras do Cockpit do gestor (sem Angular): faixas, cards, grupos, "atualizado há X" e o debounce da recarga. */

/** Recarga por evento: espera 5 s de silêncio. Sem evento algum, recarrega a cada 2 min. */
export const DEBOUNCE_RECARGA_MS = 5_000
export const FALLBACK_RECARGA_MS = 120_000
/** Eventos SSE que mudam algum número do cockpit. (Tarefa e agenda não emitem evento: o fallback cobre.) */
export const EVENTOS_DO_COCKPIT: readonly string[] = [
  'atendimento.mudou', 'notificacao.nova', 'conversa.devolvida', 'conversa.reatribuida',
]

// ── faixas do "aguardando humano": cor + rótulo, nunca cor sozinha ──

export const ROTULO_FAIXA: Readonly<Record<FaixaAguardando, string>> = {
  ok: 'No prazo', atencao: 'Atenção', estourado: 'Estourado',
}
export const TOM_FAIXA: Readonly<Record<FaixaAguardando, 'sucesso' | 'atencao' | 'erro'>> = {
  ok: 'sucesso', atencao: 'atencao', estourado: 'erro',
}

/** A pior faixa presente (estourado > atenção > no prazo); null se ninguém espera. */
export function piorFaixa(f: PorFaixa): FaixaAguardando | null {
  if (f.estourado > 0) return 'estourado'
  if (f.atencao > 0) return 'atencao'
  if (f.ok > 0) return 'ok'
  return null
}

export function tomDoAguardando(f: PorFaixa): TomStat {
  const p = piorFaixa(f)
  return p === null ? 'neutro' : TOM_FAIXA[p]
}

/** "2 no prazo · 1 em atenção · 2 estourados" — só as faixas com gente. */
export function resumoPorFaixa(f: PorFaixa): string {
  const partes: string[] = []
  if (f.ok > 0) partes.push(`${f.ok} no prazo`)
  if (f.atencao > 0) partes.push(`${f.atencao} em atenção`)
  if (f.estourado > 0) partes.push(`${f.estourado} ${f.estourado === 1 ? 'estourado' : 'estourados'}`)
  return partes.length > 0 ? partes.join(' · ') : 'Ninguém esperando'
}

// ── cards ──

export interface CartaoCockpit {
  readonly chave: CardCockpit
  readonly rotulo: string
  readonly valor: number
  readonly tom: TomStat
}

const TOM_BASE: Readonly<Record<CardCockpit, TomStat>> = {
  aguardandoHumano: 'neutro', slaEstouradoHoje: 'erro', esquecidos: 'atencao', reunioesHoje: 'acao',
  naoCompareceuHoje: 'atencao', semProximoPasso: 'atencao',
}

/** Os cards que existem agora: os de agenda (valor `null`) somem. O resto mantém a ordem do contrato. */
export function cartoesDoCockpit(c: CardsCockpit): readonly CartaoCockpit[] {
  const valor = (k: CardCockpit): number | null =>
    k === 'aguardandoHumano' ? c.aguardandoHumano.total : c[k]
  return CARDS_COCKPIT.flatMap((k) => {
    const v = valor(k)
    if (v === null) return []
    // Zero não grita: o tom de alerta só vale quando há o que olhar.
    const tom = k === 'aguardandoHumano' ? tomDoAguardando(c.aguardandoHumano.porFaixa) : v > 0 ? TOM_BASE[k] : 'neutro'
    return [{ chave: k, rotulo: ROTULO_CARD_COCKPIT[k], valor: v, tom }]
  })
}

// ── tabela por grupo ──

export interface LinhaGrupo extends Record<string, unknown> {
  readonly chave: string
  readonly rotulo: string
  readonly valores: Readonly<Partial<Record<CardCockpit, number>>>
  readonly total: number
}

/** Colunas da tabela: o grupo + um card por coluna (sem os de agenda quando o módulo está desligado). */
export function colunasDosGrupos(cartoes: readonly CartaoCockpit[], rotuloGrupo: string): readonly ColunaTabela[] {
  return [
    { chave: 'rotulo', rotulo: rotuloGrupo },
    ...cartoes.map((c) => ({ chave: c.chave, rotulo: c.rotulo, alinhamento: 'dir' as const, mono: true })),
  ]
}

/** Uma linha por grupo com ALGO a olhar; o grupo zerado não ocupa a tabela. Mantém a ordem da API ("sem" por último). */
export function linhasDosGrupos(grupos: readonly GrupoCockpit[], cartoes: readonly CartaoCockpit[]): readonly LinhaGrupo[] {
  return grupos.flatMap((g) => {
    const valores: Partial<Record<CardCockpit, number>> = {}
    let total = 0
    for (const c of cartoes) {
      const v = g[c.chave] ?? 0
      valores[c.chave] = v
      total += v
    }
    return total > 0 ? [{ chave: g.chave, rotulo: g.rotulo, valores, total }] : []
  })
}

// ── itens ──

export type AcaoItem = 'abrirConversa' | 'abrirFicha' | 'criarTarefa' | 'abrirEvento'

/** O que se pode fazer com a linha. Evento abre o detalhe (Realizado / Não compareceu moram lá). */
export function acoesDoItem(i: Pick<ItemCockpit, 'tipo' | 'conversaId' | 'contatoId'>): readonly AcaoItem[] {
  const a: AcaoItem[] = []
  if (i.tipo === 'evento') a.push('abrirEvento')
  if (i.conversaId) a.push('abrirConversa')
  if (i.contatoId) a.push('abrirFicha', 'criarTarefa')
  return a
}

/** "há 12 min" / "em 2 h 05" (evento mais tarde hoje). */
export function textoHa(desdeIso: string, agora: Date): string {
  const ms = agora.getTime() - Date.parse(desdeIso)
  if (!Number.isFinite(ms)) return '—'
  if (Math.abs(ms) < 60_000) return 'agora'
  return ms >= 0 ? `há ${duracaoCurta(ms)}` : `em ${duracaoCurta(ms)}`
}

/** "atualizado agora" / "atualizado há 3 min". */
export function textoAtualizado(geradoEmIso: string | null, agora: Date): string {
  if (!geradoEmIso) return ''
  const ms = agora.getTime() - Date.parse(geradoEmIso)
  if (!Number.isFinite(ms) || ms < 60_000) return 'atualizado agora'
  return `atualizado há ${duracaoCurta(ms)}`
}

export function queryDosItens(p: {
  card: CardCockpit; agrupar: string; grupo: string | null; dias: number; faixa: FaixaAguardando | null; cursor: string | null
}): string {
  const q = new URLSearchParams({ card: p.card, agrupar: p.agrupar, dias: String(p.dias) })
  if (p.grupo) q.set('grupo', p.grupo)
  if (p.faixa && p.card === 'aguardandoHumano') q.set('faixa', p.faixa)
  if (p.cursor) q.set('cursor', p.cursor)
  return q.toString()
}

// ── debounce da recarga (puro: o relógio entra por parâmetro, para testar sem esperar) ──

export interface Relogio {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(id: unknown): void
}

export interface RecargaAgendada {
  /** Chegou um evento: (re)arma a recarga para `atrasoMs` depois. Rajada vira UMA recarga. */
  acionar(): void
  /** Uma recarga aconteceu (por qualquer motivo): zera o que estava pendente e rearma o fallback. */
  recarregou(): void
  parar(): void
}

/**
 * Debounce de 5 s para eventos + fallback de 2 min sem evento. O fallback é um temporizador de UMA
 * disparada que se rearma a cada recarga — não é polling fixo: com eventos chegando, ele nunca vence.
 */
export function criarRecargaAgendada(
  recarregar: () => void, relogio: Relogio = globalThis,
  atrasoMs = DEBOUNCE_RECARGA_MS, fallbackMs = FALLBACK_RECARGA_MS,
): RecargaAgendada {
  let debounce: unknown = null
  let fallback: unknown = null
  let parado = false
  const armarFallback = (): void => {
    if (fallback !== null) relogio.clearTimeout(fallback)
    fallback = parado ? null : relogio.setTimeout(() => { fallback = null; recarregar() }, fallbackMs)
  }
  armarFallback()
  return {
    acionar() {
      if (parado) return
      if (debounce !== null) relogio.clearTimeout(debounce)
      debounce = relogio.setTimeout(() => { debounce = null; recarregar() }, atrasoMs)
    },
    recarregou() {
      if (debounce !== null) { relogio.clearTimeout(debounce); debounce = null }
      armarFallback()
    },
    parar() {
      parado = true
      if (debounce !== null) relogio.clearTimeout(debounce)
      if (fallback !== null) relogio.clearTimeout(fallback)
      debounce = null; fallback = null
    },
  }
}
