import {
  FASES_AGENTE, ROTULO_FASE, ROTULO_HANDOFF, formatarPct,
  type CriterioFase, type FaseAgente, type GoLiveDto, type MetricasAgenteDto
} from '@geracrm/shared'

/**
 * Regras PURAS da tela de fase e métricas (raia P19). A decisão (o critério
 * cumpre? pode avançar?) é do shared (`avaliarFase`); aqui só a apresentação.
 */

export type SituacaoCriterio = 'cumpre' | 'nao_cumpre' | 'indisponivel'

export function situacaoDoCriterio(c: CriterioFase): SituacaoCriterio {
  return c.ok === true ? 'cumpre' : c.ok === false ? 'nao_cumpre' : 'indisponivel'
}

export const ROTULO_SITUACAO: Readonly<Record<SituacaoCriterio, string>> = {
  cumpre: 'Cumpre',
  nao_cumpre: 'Não cumpre',
  indisponivel: 'Sem medida',
}

export const TOM_SITUACAO: Readonly<Record<SituacaoCriterio, 'sucesso' | 'erro' | 'atencao'>> = {
  cumpre: 'sucesso',
  nao_cumpre: 'erro',
  indisponivel: 'atencao',
}

/** Ordem do painel: o que segura o avanço primeiro (não cumpre → sem medida → cumpre), estável dentro do grupo. */
export function criteriosEmOrdem(cs: readonly CriterioFase[]): CriterioFase[] {
  const peso: Record<SituacaoCriterio, number> = { nao_cumpre: 0, indisponivel: 1, cumpre: 2 }
  return cs.map((c, i) => ({ c, i }))
    .sort((a, b) => peso[situacaoDoCriterio(a.c)] - peso[situacaoDoCriterio(b.c)] || a.i - b.i)
    .map((x) => x.c)
}

export interface PassoFase {
  readonly fase: FaseAgente
  readonly rotulo: string
  readonly estado: 'feita' | 'atual' | 'futura'
}

/** A trilha das cinco fases, marcando a atual. */
export function trilhaDeFases(atual: FaseAgente): PassoFase[] {
  const i = FASES_AGENTE.indexOf(atual)
  return FASES_AGENTE.map((f, j) => ({ fase: f, rotulo: ROTULO_FASE[f], estado: j < i ? 'feita' : j === i ? 'atual' : 'futura' }))
}

export interface Veredito {
  readonly tom: 'sucesso' | 'erro' | 'neutro'
  readonly titulo: string
  readonly texto: string
}

const contagem = (n: number, um: string, varios: string) => `${n} ${n === 1 ? um : varios}`

/** A frase do topo do painel. Sempre lembra que mudar o modo é na Configuração. */
export function vereditoDaFase(g: GoLiveDto): Veredito {
  const onde = 'Para mudar o modo, use a aba Configuração (pede confirmação).'
  if (g.recomendacao === 'voltar' && g.voltarPara) {
    return {
      tom: 'erro', titulo: `Critério violado — recomenda voltar para ${ROTULO_FASE[g.voltarPara]}`,
      texto: `${contagem(g.pendencias.reprovados.length, 'critério não cumpre', 'critérios não cumprem')} na revisão dos últimos ${g.janelaDias} dias. ${onde}`,
    }
  }
  if (g.podeAvancar && g.proximaFase) {
    return { tom: 'sucesso', titulo: `Pronto para ${ROTULO_FASE[g.proximaFase]}`, texto: `Todos os critérios desta fase foram cumpridos. ${onde}` }
  }
  if (!g.proximaFase) {
    return { tom: 'neutro', titulo: 'Fase final', texto: `Revisão a cada ${g.janelaDias} dias: se um critério for violado, o painel recomenda voltar uma fase.` }
  }
  const partes: string[] = []
  if (g.pendencias.reprovados.length) partes.push(contagem(g.pendencias.reprovados.length, 'critério ainda não cumpre', 'critérios ainda não cumprem'))
  if (g.pendencias.indisponiveis.length) partes.push(contagem(g.pendencias.indisponiveis.length, 'precisa de conferência à mão', 'precisam de conferência à mão'))
  return { tom: 'neutro', titulo: `Ainda em ${ROTULO_FASE[g.fase]}`, texto: `${partes.join(' e ')} antes de ${ROTULO_FASE[g.proximaFase]}.` }
}

/** "há 16 dias (12 úteis)" — e diz quando o início foi estimado. */
export function tempoNaFase(g: GoLiveDto): string {
  if (!g.inicioFase) return 'sem atividade registrada nesta fase'
  const d = `${g.dias} ${g.dias === 1 ? 'dia' : 'dias'} (${g.diasUteis} ${g.diasUteis === 1 ? 'útil' : 'úteis'})`
  return g.inicioEstimado ? `há cerca de ${d} — início estimado pela 1ª decisão` : `há ${d}`
}

export const JANELAS_METRICAS = [7, 30, 90] as const
export type JanelaMetricas = (typeof JANELAS_METRICAS)[number]

export interface Indicador {
  readonly rotulo: string
  readonly valor: string
  readonly detalhe: string | null
}

const segundos = (v: number | null) => (v === null ? '—' : `${(Math.round(v / 100) / 10).toFixed(1).replace('.', ',')} s`)
const reais = (c: number) => {
  const a = Math.round(c)
  return `R$ ${String(Math.floor(a / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${String(a % 100).padStart(2, '0')}`
}

/** Os indicadores de /v1/agente/metricas, na ordem do painel. */
export function indicadores(m: MetricasAgenteDto): Indicador[] {
  return [
    { rotulo: 'Turnos', valor: String(m.turnos), detalhe: `${m.conversas} ${m.conversas === 1 ? 'conversa' : 'conversas'}` },
    { rotulo: 'Respondidos / sugeridos', valor: `${m.respondidos} / ${m.sugeridos}`, detalhe: null },
    { rotulo: 'Passados para humano', valor: String(m.handoffs), detalhe: m.turnos ? `${formatarPct(m.handoffs / m.turnos)} dos turnos` : null },
    { rotulo: 'Custo por conversa', valor: reais(m.custoPorConversaCentavos), detalhe: `total ${reais(m.custoCentavos)}` },
    { rotulo: 'p95 de resposta', valor: segundos(m.latenciaP95Ms), detalhe: null },
    { rotulo: 'Com número bloqueado', valor: String(m.turnosComNumeroBloqueado), detalhe: 'turnos' },
    { rotulo: 'Pedidos', valor: `${m.pedidos.propostos} → ${m.pedidos.confirmados} → ${m.pedidos.efetivados}`, detalhe: 'propostos → confirmados → efetivados' },
    { rotulo: 'Corrigidas por humano', valor: String(m.conversasCorrigidasPorHumano), detalhe: 'conversas' },
    { rotulo: 'Cache do prompt', valor: formatarPct(m.taxaCache), detalhe: null },
  ]
}

/** Rótulo legível do motivo de handoff (o código cru quando desconhecido). */
export function rotuloDoMotivo(motivo: string): string {
  if (motivo === 'sem_motivo') return 'sem motivo registrado'
  return (ROTULO_HANDOFF as Readonly<Record<string, string>>)[motivo] ?? motivo
}
