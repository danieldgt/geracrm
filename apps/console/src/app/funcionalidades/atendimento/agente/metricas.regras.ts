import {
  FASES_AGENTE, ROTULO_FASE, ROTULO_HANDOFF, ROTULO_MODO, corpoConferenciaGoLive, formatarPct,
  type CorpoConferenciaGoLive, type CriterioFase, type FaseAgente, type GoLiveDto, type MetricasAgenteDto, type ModoAgente,
} from '@geracrm/shared'

/**
 * Regras PURAS da tela de fase e métricas (raia P19). A decisão (o critério
 * cumpre? pode avançar?) é do shared (`avaliarFase`); aqui só a apresentação.
 */

/** `revisar` = cumpre, mas pede revisão humana (alerta, ex.: pedido desfeito no autônomo amplo). */
export type SituacaoCriterio = 'cumpre' | 'revisar' | 'nao_cumpre' | 'indisponivel'

export function situacaoDoCriterio(c: CriterioFase): SituacaoCriterio {
  if (c.ok === false) return 'nao_cumpre'
  if (c.ok === null) return 'indisponivel'
  return c.alerta ? 'revisar' : 'cumpre'
}

export const ROTULO_SITUACAO: Readonly<Record<SituacaoCriterio, string>> = {
  cumpre: 'Cumpre',
  revisar: 'Revisar',
  nao_cumpre: 'Não cumpre',
  indisponivel: 'Sem medida',
}

export const TOM_SITUACAO: Readonly<Record<SituacaoCriterio, 'sucesso' | 'erro' | 'atencao'>> = {
  cumpre: 'sucesso',
  revisar: 'atencao',
  nao_cumpre: 'erro',
  indisponivel: 'atencao',
}

/** Ordem do painel: o que segura o avanço primeiro (não cumpre → revisar → sem medida → cumpre), estável dentro do grupo. */
export function criteriosEmOrdem(cs: readonly CriterioFase[]): CriterioFase[] {
  const peso: Record<SituacaoCriterio, number> = { nao_cumpre: 0, revisar: 1, indisponivel: 2, cumpre: 3 }
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
  const alertas = g.pendencias.alertas.length
    ? ` ${contagem(g.pendencias.alertas.length, 'critério pede revisão', 'critérios pedem revisão')}.` : ''
  if (!g.proximaFase) {
    return {
      tom: 'neutro', titulo: 'Fase final',
      texto: `Revisão a cada ${g.janelaDias} dias: se um critério for violado, o painel recomenda voltar uma fase.${alertas} ${onde}`,
    }
  }
  const partes: string[] = []
  if (g.pendencias.reprovados.length) partes.push(contagem(g.pendencias.reprovados.length, 'critério ainda não cumpre', 'critérios ainda não cumprem'))
  if (g.pendencias.indisponiveis.length) partes.push(contagem(g.pendencias.indisponiveis.length, 'ainda não tem medida', 'ainda não têm medida'))
  return {
    tom: 'neutro', titulo: `Ainda em ${ROTULO_FASE[g.fase]}`,
    texto: `${partes.join(' e ')} antes de ${ROTULO_FASE[g.proximaFase]}.${alertas} ${onde}`,
  }
}

/** Nome curto do modo para a tela ("Sombra", não o código). */
export function rotuloCurtoDoModo(m: ModoAgente): string {
  return ROTULO_MODO[m].split(' — ')[0]!
}

/** O número ainda não teve atividade nesta fase (sem início registrado nem decisão): a tela mostra o vazio. */
export function semAtividade(g: GoLiveDto): boolean {
  return g.inicioFase === null && g.fase !== 'homologacao'
}

/** "há 16 dias (12 úteis)" — e diz quando o início foi estimado. */
export function tempoNaFase(g: GoLiveDto): string {
  if (!g.inicioFase) return 'sem atividade registrada nesta fase'
  const d = `${g.dias} ${g.dias === 1 ? 'dia' : 'dias'} (${g.diasUteis} ${g.diasUteis === 1 ? 'útil' : 'úteis'})`
  const pausa = g.diasPausados > 0
    ? `; ${String(g.diasPausados).replace('.', ',')} ${g.diasPausados === 1 ? 'dia pausado' : 'dias pausados'} pelo teto da conta não ${g.diasPausados === 1 ? 'conta' : 'contam'}` : ''
  return (g.inicioEstimado ? `há cerca de ${d} — início estimado pela 1ª decisão` : `há ${d}`) + pausa
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

/**
 * O corpo da conferência das douradas a partir do que foi digitado — validado
 * pelo MESMO schema da API (`corpoConferenciaGoLive`, shared).
 */
export function corpoDasDouradas(
  canalId: string, cenarios: string, criticas: string,
): { readonly ok: true; readonly corpo: CorpoConferenciaGoLive } | { readonly ok: false; readonly erro: string } {
  const n = (t: string) => (/^\s*\d+\s*$/.test(t) ? Number(t) : NaN)
  const corpo = { item: 'douradas' as const, canalId, cenarios: n(cenarios), criticas: n(criticas) }
  if (Number.isNaN(corpo.cenarios) || Number.isNaN(corpo.criticas)) return { ok: false, erro: 'Digite números inteiros em cenários e CRÍTICAs.' }
  const p = corpoConferenciaGoLive.safeParse(corpo)
  if (!p.success) {
    const i = p.error.issues[0]!
    return { ok: false, erro: i.path[0] === 'criticas' ? 'Não pode haver mais CRÍTICAs que cenários.' : 'Informe ao menos 1 cenário.' }
  }
  return { ok: true, corpo }
}
