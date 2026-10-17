import type { ModoAgente } from './agente-vendedor.js'
import { maisRestritivo, recorteAgente, recorteRestringe } from './agente-modo.js'
import { META_CONCORDANCIA, MIN_REVISADAS_CONCORDANCIA } from './agente-revisao.js'
import { LIMIAR_SIMILARIDADE_SOMBRA } from './agente-sugestao.js'
import type { MetricaSlaHandoff } from './agente-sla.js'

/**
 * PAINEL E CRITÉRIO DE FASE DO AGENTE (raia P19 de docs/plano-port-playbook-am.md; ADR-031).
 *
 * homologação → sombra → assistido → autônomo num recorte → autônomo amplo.
 *
 * Cada fase tem critérios NUMÉRICOS para avançar. A avaliação é PURA
 * (`avaliarFase`): a API coleta as medidas (cada uma pode estar indisponível,
 * com o motivo) e aqui se decide, sem relógio nem banco.
 *
 * ⚠️ Os ALVOS abaixo são PROPOSTA (ADR-031, "Critérios de fase B2B — PROPOSTA"):
 *    números da AM adaptados ao B2B, a validar com o primeiro cliente antes de
 *    virarem regra. Mudar um alvo = mudar a constante nomeada AQUI.
 * ⚠️ O painel só INFORMA. Mudar o modo continua na tela de configuração (P14),
 *    com confirmação digitada e auditoria.
 * ⚠️ Falha fechada: critério indisponível NÃO conta como cumprido —
 *    `podeAvancar` exige todos os critérios medidos e cumpridos; o que falta
 *    conferir à mão vem nomeado em `pendencias.indisponiveis`.
 *
 * TypeScript puro: consumido pela API, pelo console e pelo app.
 */

// ── fases ───────────────────────────────────────────────────────────────────

export const FASES_AGENTE = ['homologacao', 'sombra', 'assistido', 'autonomo_recorte', 'autonomo_amplo'] as const
export type FaseAgente = (typeof FASES_AGENTE)[number]

export const ROTULO_FASE: Readonly<Record<FaseAgente, string>> = {
  homologacao: 'Homologação',
  sombra: 'Sombra',
  assistido: 'Assistido',
  autonomo_recorte: 'Autônomo num recorte',
  autonomo_amplo: 'Autônomo amplo',
}

export function ehFaseAgente(v: unknown): v is FaseAgente {
  return typeof v === 'string' && (FASES_AGENTE as readonly string[]).includes(v)
}

/** A fase seguinte; null na última (autônomo amplo é permanente, com revisão). */
export function proximaFase(f: FaseAgente): FaseAgente | null {
  const i = FASES_AGENTE.indexOf(f)
  return FASES_AGENTE[i + 1] ?? null
}

/** A fase anterior; null na primeira. */
export function faseAnterior(f: FaseAgente): FaseAgente | null {
  const i = FASES_AGENTE.indexOf(f)
  return i > 0 ? FASES_AGENTE[i - 1]! : null
}

/**
 * A FASE do número a partir do modo (P14, ADR-028): o modo do número limitado
 * pelo teto do tenant ("o mais restritivo vence"). Autônomo com recorte que
 * restringe (horário ou segmento) é "autônomo num recorte"; sem recorte, amplo.
 *
 * ⚠️ É o modo ESTRUTURAL do número, não o do minuto: um número autônomo às 22h
 *    fora do horário do recorte está em sombra AGORA, mas a fase dele continua
 *    "autônomo num recorte". O modo efetivo do momento vem ao lado, informativo.
 * ⚠️ Recorte inválido no banco conta como recorte (errar para o lado restritivo).
 */
export function faseDoModo(e: { readonly modoNumero: ModoAgente; readonly modoTenant: ModoAgente | null; readonly recorte: unknown }): FaseAgente {
  const modo = maisRestritivo(e.modoNumero, e.modoTenant ?? 'autonomo')
  switch (modo) {
    case 'desligado': return 'homologacao'
    case 'sombra': return 'sombra'
    case 'assistido': return 'assistido'
    case 'autonomo': {
      if (e.recorte === null || e.recorte === undefined) return 'autonomo_amplo'
      const p = recorteAgente.safeParse(e.recorte)
      if (!p.success) return 'autonomo_recorte'
      return recorteRestringe(p.data) ? 'autonomo_recorte' : 'autonomo_amplo'
    }
  }
}

/** O modo de agente_decisao que cada fase produz (a janela de medida filtra por ele). */
export const MODO_DA_FASE: Readonly<Record<FaseAgente, ModoAgente | 'simulacao'>> = {
  homologacao: 'simulacao',
  sombra: 'sombra',
  assistido: 'assistido',
  autonomo_recorte: 'autonomo',
  autonomo_amplo: 'autonomo',
}

// ── alvos (⚠️ PROPOSTA — ADR-031) ───────────────────────────────────────────

/** PROPOSTA. Homologação: conversas douradas (evals P15) sem CRÍTICA. */
export const ALVO_DOURADAS_MIN = 25
/** PROPOSTA. Homologação: conversas no playground sem CRÍTICA. */
export const ALVO_PLAYGROUND_CONVERSAS_MIN = 30
/** PROPOSTA. Sombra: duração e volume mínimos. */
export const ALVO_SOMBRA_DIAS_UTEIS_MIN = 10
export const ALVO_SOMBRA_TURNOS_MIN = 150
export const ALVO_SOMBRA_CONVERSAS_MIN = 50
/** PROPOSTA. Sombra: fração dos turnos comparados com similaridade ≥ LIMIAR_SIMILARIDADE_SOMBRA (0,6). */
export const ALVO_SIMILARIDADE_SOMBRA_TAXA_MIN = 0.6
/** PROPOSTA. Nota média do juiz (0–5). Só vale com a concordância na meta (ADR-031 §5). */
export const ALVO_NOTA_JUIZ_MIN = 4
/** PROPOSTA. Custo por conversa: R$ 1,50. */
export const ALVO_CUSTO_CONVERSA_MAX_CENTAVOS = 150
/** PROPOSTA. Turnos com número bloqueado pelo guardrail (P7) ÷ turnos com resposta. */
export const ALVO_NUMEROS_BLOQUEADOS_TAXA_MAX = 0.02
/** PROPOSTA. Assistido: duração e volume mínimos. */
export const ALVO_ASSISTIDO_DIAS_UTEIS_MIN = 10
export const ALVO_ASSISTIDO_SUGESTOES_MIN = 100
/** PROPOSTA. Assistido: uso (enviadas + editadas ÷ geradas). */
export const ALVO_USO_TAXA_MIN = 0.4
/** PROPOSTA. Assistido: enviadas sem edição ÷ usadas, com um mínimo de usadas. */
export const ALVO_SEM_EDICAO_TAXA_MIN = 0.7
export const ALVO_SEM_EDICAO_USADAS_MIN = 50
/** PROPOSTA. Autônomo num recorte: duração mínima (dias corridos). */
export const ALVO_RECORTE_DIAS_MIN = 21
/** PROPOSTA. Autônomo num recorte: janela do "0 CRÍTICA". */
export const ALVO_RECORTE_JANELA_CRITICA_DIAS = 14
/** PROPOSTA. Autônomo amplo: janela da revisão periódica. */
export const ALVO_AMPLO_JANELA_DIAS = 30
/** PROPOSTA. p95 da 1ª resposta da sessão. */
export const ALVO_P95_PRIMEIRA_RESPOSTA_MAX_MS = 6_000
/** PROPOSTA. Conversas com handoff ÷ conversas do agente. Abaixo de 10% ele segura o que não devia. */
export const ALVO_HANDOFF_TAXA_MIN = 0.1
export const ALVO_HANDOFF_TAXA_MAX = 0.4
/** PROPOSTA. Conversas com opt-out ÷ conversas do agente. */
export const ALVO_OPT_OUT_TAXA_MAX = 0.01
/** PROPOSTA. Conversão do agente não pode ficar mais que 2 p.p. abaixo da coorte humana. */
export const ALVO_CONVERSAO_MARGEM = 0.02
/** PROPOSTA. Mínimo de conversas em CADA coorte para a comparação valer. */
export const ALVO_CONVERSAO_COORTE_MIN = 30
/** PROPOSTA. Handoffs atendidos dentro do SLA (P18, `pctCumprido`). */
export const ALVO_SLA_CUMPRIDO_MIN = 0.9

// ── medidas ─────────────────────────────────────────────────────────────────

/** Uma medida: o valor, ou indisponível com o motivo (fonte ausente, sem registro no banco, falha). */
export type Medida<T> =
  | { readonly disponivel: true; readonly valor: T }
  | { readonly disponivel: false; readonly motivo: string }

export function medido<T>(valor: T): Medida<T> {
  return { disponivel: true, valor }
}
export function indisponivel(motivo: string): { readonly disponivel: false; readonly motivo: string } {
  return { disponivel: false, motivo }
}

export interface MedidasFase {
  /** Evals P15 (douradas): cenários rodados e CRÍTICAs. */
  readonly douradas: Medida<{ readonly cenarios: number; readonly criticas: number }>
  /** `pnpm agente:smoke` passou. */
  readonly smoke: Medida<boolean>
  /** Playground: conversas de simulação e CRÍTICAs que a regra de qualidade pegou nelas. */
  readonly playground: Medida<{ readonly conversas: number; readonly criticas: number }>
  /** Decisões no modo da fase, na janela (sem silêncio). */
  readonly volume: Medida<{ readonly turnos: number; readonly conversas: number }>
  /** CRÍTICAs que ESCAPARAM (P12, `agente_avaliacao.pior_gravidade`), na janela da fase. */
  readonly criticas: Medida<number>
  /** Nota média do juiz (P12) e quantas avaliações. */
  readonly notaJuiz: Medida<{ readonly media: number | null; readonly avaliadas: number }>
  /** Concordância humano × juiz (P16). */
  readonly concordancia: Medida<{
    readonly valor: number | null; readonly comparaveis: number; readonly falsosNegativosCritica: number; readonly atingeMeta: boolean
  }>
  /** Sombra × humano (P13). */
  readonly similaridadeSombra: Medida<{ readonly comparados: number; readonly taxaAcima: number | null }>
  /** Custo por conversa (P6), centavos; null sem conversas. */
  readonly custoPorConversa: Medida<{ readonly centavos: number | null; readonly conversas: number }>
  /** Turnos com resposta e quantos tiveram número bloqueado (P7). */
  readonly numerosBloqueados: Medida<{ readonly turnos: number; readonly comBloqueio: number }>
  /** Sugestões do assistido (P13). */
  readonly sugestoes: Medida<{
    readonly geradas: number; readonly usadas: number; readonly taxaUso: number | null; readonly taxaSemEdicao: number | null
  }>
  /** p95 da 1ª resposta da sessão, ms. */
  readonly latenciaPrimeira: Medida<{ readonly p95Ms: number | null; readonly amostras: number }>
  readonly handoff: Medida<{ readonly conversas: number; readonly comHandoff: number }>
  /** Opt-out pedido ao agente (P4). */
  readonly optOut: Medida<{ readonly conversas: number; readonly comOptOut: number }>
  /** Conversão em pedido: coorte do agente × coorte humana, mesmo número e janela. */
  readonly conversao: Medida<{
    readonly agente: { readonly conversas: number; readonly convertidas: number }
    readonly humano: { readonly conversas: number; readonly convertidas: number }
  }>
  /** Pedidos que o agente levou à confirmação e que depois foram cancelados (proxy de "confirmado errado"). */
  readonly pedidosErrados: Medida<{ readonly confirmados: number; readonly cancelados: number }>
  /**
   * SLA do handoff (P18): o mesmo bloco `slaHandoff` de /v1/performance, do número.
   * ⚠️ `pctCumprido` vem em PERCENTUAL INTEIRO (0–100), como a P18 devolve.
   */
  readonly slaHandoff: Medida<MetricaSlaHandoff>
}

export type FonteMedida = keyof MedidasFase


// ── critérios ───────────────────────────────────────────────────────────────

export interface CriterioFase {
  readonly id: string
  readonly rotulo: string
  /** O alvo legível ("≥ 85% com ≥ 20 revisadas"). */
  readonly alvo: string
  /** O valor medido legível; null quando indisponível. */
  readonly valor: string | null
  /** true cumpre, false não cumpre, null indisponível. */
  readonly ok: boolean | null
  /** De onde vem o número (tabela/raia). */
  readonly fonte: string
  readonly indisponivel?: true
  /** Por que está indisponível, ou observação sobre o valor. */
  readonly motivo?: string
}

/** Recomendação do painel — só informa; quem muda o modo é a pessoa, na tela da P14. */
export type RecomendacaoFase = 'avancar' | 'manter' | 'voltar'

export interface EntradaFase {
  readonly fase: FaseAgente
  /** Dias corridos desde o início da fase. */
  readonly diasCorridos: number
  /** Dias úteis (seg–sex) completos desde o início da fase. */
  readonly diasUteis: number
  readonly medidas: Partial<MedidasFase>
}

export interface ResultadoFase {
  readonly fase: FaseAgente
  readonly proximaFase: FaseAgente | null
  readonly criterios: readonly CriterioFase[]
  /** Todos os critérios medidos e cumpridos. Na última fase, sempre false. */
  readonly podeAvancar: boolean
  readonly recomendacao: RecomendacaoFase
  /** Para onde voltar quando a recomendação é 'voltar'. */
  readonly voltarPara: FaseAgente | null
  readonly pendencias: { readonly reprovados: readonly string[]; readonly indisponiveis: readonly string[] }
}

// ── formatação (pt-BR, sem Intl para não depender do runtime) ──────────────

const virgula = (s: string) => s.replace('.', ',')
export function formatarPct(x: number | null): string {
  if (x === null) return '—'
  const v = Math.round(x * 1000) / 10
  return `${virgula(Number.isInteger(v) ? String(v) : v.toFixed(1))}%`
}
export function formatarCentavos(c: number): string {
  const neg = c < 0 ? '-' : ''
  const a = Math.abs(Math.round(c))
  const reais = String(Math.floor(a / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return `${neg}R$ ${reais},${String(a % 100).padStart(2, '0')}`
}
const fmtMs = (ms: number) => `${virgula((Math.round(ms / 100) / 10).toFixed(1))} s`
const fmtNota = (n: number) => virgula(n.toFixed(2))
const pp = (x: number) => `${virgula((Math.round(x * 1000) / 10).toFixed(1))} p.p.`

// ── construção dos critérios ────────────────────────────────────────────────

const FONTE = {
  evals: 'Evals do agente (P15)',
  smoke: 'Smoke do provedor (P15)',
  playground: 'Playground: agente_decisao (simulação) + regras de qualidade',
  decisao: 'agente_decisao',
  qualidade: 'Qualidade em produção: agente_avaliacao (P12)',
  juiz: 'Juiz amostrado: agente_avaliacao (P12)',
  revisao: 'Revisão humana: agente_revisao (P16)',
  sombra: 'Sombra × humano: agente_decisao.sombra_similaridade (P13)',
  custo: 'Custo por turno: agente_decisao.custo_centavos (P6)',
  numeros: 'Guardrail numérico: agente_decisao (P7)',
  sugestoes: 'Sugestões do assistido (P13)',
  latencia: 'agente_decisao.latencia_ms (1ª resposta da sessão)',
  handoff: 'agente_decisao.desfecho = handoff',
  optOut: 'Gatilho de opt-out: agente_decisao.guardrails (P4)',
  conversao: 'pedido (confirmado ou efetivado) por conversa',
  pedidos: 'pedido de origem agente: confirmado e depois cancelado',
  sla: 'SLA do handoff: atendimento (P18)',
} as const

type Avaliador = (e: EntradaFase) => CriterioFase

function semMedida(id: string, rotulo: string, alvo: string, fonte: string, motivo: string): CriterioFase {
  return { id, rotulo, alvo, valor: null, ok: null, fonte, indisponivel: true, motivo }
}

/** Lê a medida; se faltar ou estiver indisponível, devolve o critério indisponível. */
function com<K extends FonteMedida>(
  e: EntradaFase, chave: K, id: string, rotulo: string, alvo: string, fonte: string,
  fn: (v: Extract<MedidasFase[K], { disponivel: true }>['valor']) => { valor: string; ok: boolean; motivo?: string },
): CriterioFase {
  const m = e.medidas[chave]
  if (!m) return semMedida(id, rotulo, alvo, fonte, 'Medida não coletada para esta fase.')
  if (!m.disponivel) return semMedida(id, rotulo, alvo, fonte, m.motivo)
  const r = fn(m.valor as Extract<MedidasFase[K], { disponivel: true }>['valor'])
  return { id, rotulo, alvo, valor: r.valor, ok: r.ok, fonte, ...(r.motivo ? { motivo: r.motivo } : {}) }
}

const taxa = (n: number, d: number): number | null => (d > 0 ? n / d : null)

function diasUteisMin(min: number): Avaliador {
  return (e) => ({
    id: 'dias_uteis', rotulo: 'Tempo na fase', alvo: `≥ ${min} dias úteis`,
    valor: `${e.diasUteis} ${e.diasUteis === 1 ? 'dia útil' : 'dias úteis'}`, ok: e.diasUteis >= min, fonte: 'Auditoria da configuração do modo (P14)',
  })
}

const criticaZero = (id: string, rotulo: string): Avaliador => (e) =>
  com(e, 'criticas', id, rotulo, '0', FONTE.qualidade, (n) => ({ valor: String(n), ok: n === 0 }))

const C = {
  douradas: (e: EntradaFase) => com(e, 'douradas', 'douradas', 'Conversas douradas sem CRÍTICA', `≥ ${ALVO_DOURADAS_MIN} cenários, 0 CRÍTICA`, FONTE.evals,
    (v) => ({ valor: `${v.cenarios} cenários, ${v.criticas} CRÍTICA`, ok: v.cenarios >= ALVO_DOURADAS_MIN && v.criticas === 0 })),
  smoke: (e: EntradaFase) => com(e, 'smoke', 'smoke', 'Smoke do provedor de IA', 'ok', FONTE.smoke,
    (v) => ({ valor: v ? 'ok' : 'falhou', ok: v })),
  playgroundVolume: (e: EntradaFase) => com(e, 'playground', 'playground_conversas', 'Conversas no playground', `≥ ${ALVO_PLAYGROUND_CONVERSAS_MIN}`, FONTE.playground,
    (v) => ({ valor: String(v.conversas), ok: v.conversas >= ALVO_PLAYGROUND_CONVERSAS_MIN })),
  playgroundCritica: (e: EntradaFase) => com(e, 'playground', 'playground_critica', 'CRÍTICA no playground', '0', FONTE.playground,
    (v) => ({ valor: String(v.criticas), ok: v.criticas === 0 })),
  turnos: (min: number): Avaliador => (e) => com(e, 'volume', 'turnos', 'Turnos na fase', `≥ ${min}`, FONTE.decisao,
    (v) => ({ valor: String(v.turnos), ok: v.turnos >= min })),
  conversas: (min: number): Avaliador => (e) => com(e, 'volume', 'conversas', 'Conversas na fase', `≥ ${min}`, FONTE.decisao,
    (v) => ({ valor: String(v.conversas), ok: v.conversas >= min })),
  similaridade: (e: EntradaFase) => com(e, 'similaridadeSombra', 'similaridade_sombra', 'Sombra parecida com o humano',
    `≥ ${formatarPct(ALVO_SIMILARIDADE_SOMBRA_TAXA_MIN)} dos turnos com similaridade ≥ ${virgula(String(LIMIAR_SIMILARIDADE_SOMBRA))}`, FONTE.sombra,
    (v) => v.comparados === 0 || v.taxaAcima === null
      ? { valor: 'nenhum turno comparado', ok: false, motivo: 'Sem resposta humana depois de um turno de sombra na janela.' }
      : { valor: `${formatarPct(v.taxaAcima)} de ${v.comparados}`, ok: v.taxaAcima >= ALVO_SIMILARIDADE_SOMBRA_TAXA_MIN }),
  nota: (e: EntradaFase): CriterioFase => {
    const conc = e.medidas.concordancia
    return com(e, 'notaJuiz', 'nota_juiz', 'Nota média do juiz', `≥ ${virgula(ALVO_NOTA_JUIZ_MIN.toFixed(1))} (com concordância na meta)`, FONTE.juiz,
      (v) => {
        if (v.media === null || v.avaliadas === 0) return { valor: 'sem avaliações', ok: false }
        const valor = `${fmtNota(v.media)} em ${v.avaliadas}`
        const naMeta = !!conc && conc.disponivel && conc.valor.atingeMeta
        if (!naMeta) return { valor, ok: false, motivo: 'Sem a concordância humana na meta, a nota do juiz não vale como critério (ADR-031 §5).' }
        return { valor, ok: v.media >= ALVO_NOTA_JUIZ_MIN }
      })
  },
  concordancia: (e: EntradaFase) => com(e, 'concordancia', 'concordancia', 'Concordância humano × juiz',
    `≥ ${formatarPct(META_CONCORDANCIA)} com ≥ ${MIN_REVISADAS_CONCORDANCIA} revisadas e 0 CRÍTICA não vista`, FONTE.revisao,
    (v) => ({
      valor: v.valor === null ? `nenhuma comparável` : `${formatarPct(v.valor)} em ${v.comparaveis}${v.falsosNegativosCritica ? ` · ${v.falsosNegativosCritica} CRÍTICA não vista` : ''}`,
      ok: v.atingeMeta,
    })),
  custo: (e: EntradaFase) => com(e, 'custoPorConversa', 'custo_conversa', 'Custo por conversa', `≤ ${formatarCentavos(ALVO_CUSTO_CONVERSA_MAX_CENTAVOS)}`, FONTE.custo,
    (v) => v.centavos === null ? { valor: 'sem conversas', ok: false } : { valor: formatarCentavos(v.centavos), ok: v.centavos <= ALVO_CUSTO_CONVERSA_MAX_CENTAVOS }),
  numeros: (e: EntradaFase) => com(e, 'numerosBloqueados', 'numeros_bloqueados', 'Turnos com número bloqueado', `≤ ${formatarPct(ALVO_NUMEROS_BLOQUEADOS_TAXA_MAX)}`, FONTE.numeros,
    (v) => {
      const t = taxa(v.comBloqueio, v.turnos)
      return t === null ? { valor: 'sem turnos com resposta', ok: false } : { valor: `${formatarPct(t)} (${v.comBloqueio} de ${v.turnos})`, ok: t <= ALVO_NUMEROS_BLOQUEADOS_TAXA_MAX }
    }),
  sugestoesVolume: (e: EntradaFase) => com(e, 'sugestoes', 'sugestoes', 'Sugestões geradas', `≥ ${ALVO_ASSISTIDO_SUGESTOES_MIN}`, FONTE.sugestoes,
    (v) => ({ valor: String(v.geradas), ok: v.geradas >= ALVO_ASSISTIDO_SUGESTOES_MIN })),
  uso: (e: EntradaFase) => com(e, 'sugestoes', 'uso_sugestao', 'Sugestões usadas pelo vendedor', `≥ ${formatarPct(ALVO_USO_TAXA_MIN)}`, FONTE.sugestoes,
    (v) => v.taxaUso === null ? { valor: 'sem sugestões', ok: false } : { valor: `${formatarPct(v.taxaUso)} de ${v.geradas}`, ok: v.taxaUso >= ALVO_USO_TAXA_MIN }),
  semEdicao: (e: EntradaFase) => com(e, 'sugestoes', 'sem_edicao', 'Enviadas sem edição',
    `≥ ${formatarPct(ALVO_SEM_EDICAO_TAXA_MIN)} com ≥ ${ALVO_SEM_EDICAO_USADAS_MIN} enviadas`, FONTE.sugestoes,
    (v) => v.taxaSemEdicao === null
      ? { valor: 'nenhuma enviada', ok: false }
      : { valor: `${formatarPct(v.taxaSemEdicao)} de ${v.usadas}`, ok: v.usadas >= ALVO_SEM_EDICAO_USADAS_MIN && v.taxaSemEdicao >= ALVO_SEM_EDICAO_TAXA_MIN }),
  diasCorridos: (min: number): Avaliador => (e) => ({
    id: 'dias', rotulo: 'Tempo na fase', alvo: `≥ ${min} dias`, valor: `${e.diasCorridos} ${e.diasCorridos === 1 ? 'dia' : 'dias'}`,
    ok: e.diasCorridos >= min, fonte: 'Auditoria da configuração do modo (P14)',
  }),
  p95: (e: EntradaFase) => com(e, 'latenciaPrimeira', 'p95_primeira', 'p95 da 1ª resposta', `≤ ${fmtMs(ALVO_P95_PRIMEIRA_RESPOSTA_MAX_MS)}`, FONTE.latencia,
    (v) => v.p95Ms === null || v.amostras === 0 ? { valor: 'sem respostas', ok: false } : { valor: `${fmtMs(v.p95Ms)} (${v.amostras})`, ok: v.p95Ms <= ALVO_P95_PRIMEIRA_RESPOSTA_MAX_MS }),
  handoff: (e: EntradaFase) => com(e, 'handoff', 'handoff', 'Conversas passadas para humano',
    `entre ${formatarPct(ALVO_HANDOFF_TAXA_MIN)} e ${formatarPct(ALVO_HANDOFF_TAXA_MAX)}`, FONTE.handoff,
    (v) => {
      const t = taxa(v.comHandoff, v.conversas)
      return t === null ? { valor: 'sem conversas', ok: false } : { valor: `${formatarPct(t)} (${v.comHandoff} de ${v.conversas})`, ok: t >= ALVO_HANDOFF_TAXA_MIN && t <= ALVO_HANDOFF_TAXA_MAX }
    }),
  optOut: (e: EntradaFase) => com(e, 'optOut', 'opt_out', 'Opt-out nas conversas do agente', `≤ ${formatarPct(ALVO_OPT_OUT_TAXA_MAX)}`, FONTE.optOut,
    (v) => {
      const t = taxa(v.comOptOut, v.conversas)
      return t === null ? { valor: 'sem conversas', ok: false } : { valor: `${formatarPct(t)} (${v.comOptOut} de ${v.conversas})`, ok: t <= ALVO_OPT_OUT_TAXA_MAX }
    }),
  conversao: (e: EntradaFase) => com(e, 'conversao', 'conversao', 'Conversão em pedido × coorte humana',
    `não-inferior (até −${pp(ALVO_CONVERSAO_MARGEM)}), ≥ ${ALVO_CONVERSAO_COORTE_MIN} conversas em cada`, FONTE.conversao,
    (v) => {
      const a = taxa(v.agente.convertidas, v.agente.conversas), h = taxa(v.humano.convertidas, v.humano.conversas)
      const valor = `agente ${formatarPct(a)} (${v.agente.conversas}) × humano ${formatarPct(h)} (${v.humano.conversas})`
      if (v.agente.conversas < ALVO_CONVERSAO_COORTE_MIN || v.humano.conversas < ALVO_CONVERSAO_COORTE_MIN || a === null || h === null) {
        return { valor, ok: false, motivo: 'Amostra insuficiente em uma das coortes.' }
      }
      return { valor, ok: a >= h - ALVO_CONVERSAO_MARGEM - 1e-9 }
    }),
  pedidos: (e: EntradaFase) => com(e, 'pedidosErrados', 'pedido_errado', 'Pedido confirmado errado', '0', FONTE.pedidos,
    (v) => ({
      valor: `${v.cancelados} de ${v.confirmados} confirmados`, ok: v.cancelados === 0,
      motivo: 'Medida aproximada: pedido do agente que o cliente confirmou e alguém cancelou depois.',
    })),
  sla: (e: EntradaFase) => com(e, 'slaHandoff', 'sla_handoff', 'SLA do handoff cumprido', `≥ ${formatarPct(ALVO_SLA_CUMPRIDO_MIN)}`, FONTE.sla,
    (v) => v.medidos === 0 || v.pctCumprido === null
      ? { valor: 'nenhum handoff medido', ok: false }
      : { valor: `${formatarPct(v.pctCumprido / 100)} de ${v.medidos}${v.pendentes ? ` · ${v.pendentes} em aberto` : ''}`, ok: v.pctCumprido / 100 >= ALVO_SLA_CUMPRIDO_MIN - 1e-9 }),
}

/** Os critérios de cada fase, na ordem em que o painel mostra (tabela P19 / ADR-031). */
export const CRITERIOS_DA_FASE: Readonly<Record<FaseAgente, readonly Avaliador[]>> = {
  homologacao: [C.douradas, C.smoke, C.playgroundVolume, C.playgroundCritica],
  sombra: [
    diasUteisMin(ALVO_SOMBRA_DIAS_UTEIS_MIN), C.turnos(ALVO_SOMBRA_TURNOS_MIN), C.conversas(ALVO_SOMBRA_CONVERSAS_MIN),
    C.similaridade, criticaZero('critica', 'CRÍTICA que escapou'), C.nota, C.concordancia, C.custo, C.numeros,
  ],
  assistido: [diasUteisMin(ALVO_ASSISTIDO_DIAS_UTEIS_MIN), C.sugestoesVolume, C.uso, C.semEdicao, criticaZero('critica', 'CRÍTICA que escapou')],
  autonomo_recorte: [
    C.diasCorridos(ALVO_RECORTE_DIAS_MIN), criticaZero('critica', `CRÍTICA nos últimos ${ALVO_RECORTE_JANELA_CRITICA_DIAS} dias`),
    C.p95, C.handoff, C.optOut, C.conversao, C.pedidos, C.sla,
  ],
  autonomo_amplo: [
    criticaZero('critica', `CRÍTICA nos últimos ${ALVO_AMPLO_JANELA_DIAS} dias`),
    C.p95, C.handoff, C.optOut, C.conversao, C.pedidos, C.sla,
  ],
}

/** As medidas que cada fase precisa — a API coleta só estas. */
export const FONTES_DA_FASE: Readonly<Record<FaseAgente, readonly FonteMedida[]>> = {
  homologacao: ['douradas', 'smoke', 'playground'],
  sombra: ['volume', 'similaridadeSombra', 'criticas', 'notaJuiz', 'concordancia', 'custoPorConversa', 'numerosBloqueados'],
  assistido: ['sugestoes', 'criticas'],
  autonomo_recorte: ['criticas', 'latenciaPrimeira', 'handoff', 'optOut', 'conversao', 'pedidosErrados', 'slaHandoff'],
  autonomo_amplo: ['criticas', 'latenciaPrimeira', 'handoff', 'optOut', 'conversao', 'pedidosErrados', 'slaHandoff'],
}

/**
 * Janela das medidas, em dias para trás a partir de agora: desde o início da
 * fase (mín. 1, máx. 90). Exceções: CRÍTICA no recorte olha 14 dias; o amplo
 * revisa os últimos 30.
 */
export function janelaDaFase(fase: FaseAgente, diasCorridos: number): { readonly dias: number; readonly diasCritica: number } {
  const desdeInicio = Math.min(Math.max(Math.ceil(diasCorridos), 1), 90)
  if (fase === 'autonomo_amplo') return { dias: ALVO_AMPLO_JANELA_DIAS, diasCritica: ALVO_AMPLO_JANELA_DIAS }
  if (fase === 'autonomo_recorte') return { dias: desdeInicio, diasCritica: Math.min(desdeInicio, ALVO_RECORTE_JANELA_CRITICA_DIAS) }
  return { dias: desdeInicio, diasCritica: desdeInicio }
}

/** AVALIAÇÃO PURA da fase. */
export function avaliarFase(e: EntradaFase): ResultadoFase {
  const criterios = CRITERIOS_DA_FASE[e.fase].map((f) => f(e))
  const reprovados = criterios.filter((c) => c.ok === false).map((c) => c.id)
  const indisponiveis = criterios.filter((c) => c.ok === null).map((c) => c.id)
  const tudoOk = reprovados.length === 0 && indisponiveis.length === 0
  const proxima = proximaFase(e.fase)
  let recomendacao: RecomendacaoFase
  let voltarPara: FaseAgente | null = null
  if (e.fase === 'autonomo_amplo') {
    // Amplo é permanente: revisão a cada 30 dias; critério violado → volta uma fase.
    if (reprovados.length > 0) { recomendacao = 'voltar'; voltarPara = faseAnterior(e.fase) } else recomendacao = 'manter'
  } else {
    recomendacao = tudoOk ? 'avancar' : 'manter'
  }
  return {
    fase: e.fase, proximaFase: proxima, criterios,
    podeAvancar: proxima !== null && tudoOk,
    recomendacao, voltarPara,
    pendencias: { reprovados, indisponiveis },
  }
}

// ── dias úteis ──────────────────────────────────────────────────────────────

const DIA_MS = 86_400_000
const dataUtc = (d: string): number => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)))

/**
 * Dias úteis (seg–sex) COMPLETOS entre duas datas locais "AAAA-MM-DD": conta
 * de `inicio` (inclusive) até `hoje` (exclusive — o dia de hoje ainda não acabou).
 * ⚠️ Feriado não desconta (a fase dura um pouco menos que o nome diz no mês de feriado).
 */
export function diasUteisEntre(inicio: string, hoje: string): number {
  const a = dataUtc(inicio), b = dataUtc(hoje)
  if (!(b > a)) return 0
  let n = 0
  for (let t = a; t < b; t += DIA_MS) {
    const dow = new Date(t).getUTCDay()
    if (dow !== 0 && dow !== 6) n++
  }
  return n
}

// ── contrato HTTP ───────────────────────────────────────────────────────────

/** GET /v1/agente/go-live?canalId */
export interface GoLiveDto extends ResultadoFase {
  readonly canalId: string
  readonly rotuloFase: string
  /** Dias corridos completos desde o início da fase. */
  readonly dias: number
  readonly diasUteis: number
  /** ISO; null quando não há registro nenhum. */
  readonly inicioFase: string | null
  /** true = sem auditoria da troca de modo; o início foi estimado pela 1ª decisão no modo. */
  readonly inicioEstimado: boolean
  /** Janela das medidas, em dias para trás. */
  readonly janelaDias: number
  /** O modo efetivo AGORA (P14), só informativo: fora do recorte ele cai. */
  readonly modoAgora: { readonly modo: ModoAgente; readonly origem: string; readonly motivo: string | null }
  /** Sempre true enquanto os alvos forem a PROPOSTA do ADR-031. */
  readonly alvosProposta: boolean
}

/**
 * GET /v1/agente/metricas?dias&canalId — os agregados que já existiam (rotas-agente.ts),
 * tipados aqui para o painel da P19 consumir sem duplicar interface no console.
 */
export interface MetricasAgenteDto {
  readonly dias: number
  readonly canalId: string | null
  readonly turnos: number
  readonly respondidos: number
  readonly sugeridos: number
  readonly handoffs: number
  readonly falhas: number
  readonly superadas: number
  readonly conversas: number
  readonly custoCentavos: number
  readonly custoPorConversaCentavos: number
  readonly latenciaP95Ms: number | null
  readonly turnosComNumeroBloqueado: number
  readonly taxaCache: number | null
  readonly handoffPorMotivo: readonly { readonly motivo: string; readonly n: number }[]
  readonly pedidos: { readonly propostos: number; readonly confirmados: number; readonly efetivados: number; readonly valorEfetivadoCentavos: number }
  readonly conversasCorrigidasPorHumano: number
}
