import { z } from 'zod'
import type { ModoAgente } from './agente-vendedor.js'
import { ORDEM_MODO, recorteAgente, recorteRestringe } from './agente-modo.js'
import { META_CONCORDANCIA, MIN_REVISADAS_CONCORDANCIA } from './agente-revisao.js'
import { LIMIAR_SIMILARIDADE_SOMBRA } from './agente-sugestao.js'
import type { MetricaSlaHandoff } from './agente-sla.js'

/**
 * PAINEL E CRITÉRIO DE FASE DO AGENTE (raia P19 de docs/plano-port-playbook-am.md; ADR-031).
 *
 * homologação → sombra → assistido → autônomo num recorte → autônomo amplo.
 *
 * Cada fase tem critérios NUMÉRICOS para avançar. A avaliação é PURA
 * (`avaliarFase`): a API coleta as medidas e aqui se decide, sem relógio nem banco.
 *
 * Três resultados por critério:
 *   ok = true   cumpre;
 *   ok = false  REPROVA — a medida existe, tem amostra e ficou fora do alvo;
 *   ok = null   SEM MEDIDA — fonte ausente, sem conferência, ou AMOSTRA
 *               INSUFICIENTE (sem conversas, sem respostas, coorte abaixo do
 *               mínimo). Falta de amostra nunca é reprovação: não manda voltar.
 *
 * ⚠️ Os ALVOS abaixo são PROPOSTA (ADR-031, "Critérios de fase B2B — PROPOSTA"):
 *    números da AM (§11.5) adaptados ao B2B, a validar com o primeiro cliente.
 * ⚠️ O painel só INFORMA. Mudar o modo continua na tela de configuração (P14).
 * ⚠️ Falha fechada para AVANÇAR: `podeAvancar` exige todos os critérios com
 *    ok = true. Para VOLTAR (autônomo amplo), só reprovação de verdade conta.
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
 * A FASE do número: o modo DO NÚMERO (`agente_config.modo`, P14) e o recorte.
 * Autônomo com recorte que restringe (horário ou segmento) é "autônomo num
 * recorte"; sem recorte, amplo.
 *
 * ⚠️ O teto do tenant (kill switch) NÃO muda a fase: o número aparece
 *    "pausado pelo teto" (`pausadoPeloTeto`) e volta à mesma fase quando o teto
 *    sai. Mudar a fase por causa do kill switch zeraria a contagem de dias de
 *    todos os números a cada pausa.
 * ⚠️ É o modo ESTRUTURAL, não o do minuto: fora do horário do recorte o agente
 *    está em sombra AGORA, mas a fase continua "autônomo num recorte".
 * ⚠️ Recorte inválido no banco conta como recorte (errar para o lado restritivo).
 */
export function faseDoModo(e: { readonly modoNumero: ModoAgente; readonly recorte: unknown }): FaseAgente {
  switch (e.modoNumero) {
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

/** O teto do tenant está segurando o número abaixo do modo dele? */
export function pausadoPeloTeto(modoNumero: ModoAgente, modoTenant: ModoAgente | null): boolean {
  return modoTenant !== null && ORDEM_MODO[modoTenant] < ORDEM_MODO[modoNumero]
}

/** O modo de agente_decisao que cada fase produz (a janela de medida filtra por ele). */
export const MODO_DA_FASE: Readonly<Record<FaseAgente, ModoAgente | 'simulacao'>> = {
  homologacao: 'simulacao',
  sombra: 'sombra',
  assistido: 'assistido',
  autonomo_recorte: 'autonomo',
  autonomo_amplo: 'autonomo',
}

// ── início da fase (pela auditoria do modo) ─────────────────────────────────

/** Uma mudança auditada de `agente_config` (`agente.config_alterada`): só os campos que mudaram. */
export interface MudancaDeConfig {
  readonly em: string
  readonly antes: Readonly<Record<string, unknown>>
  readonly depois: Readonly<Record<string, unknown>>
  /** A linha nasceu nesta mudança (antes = sem configuração = desligado). */
  readonly criacao: boolean
}

const ehModo = (v: unknown): v is ModoAgente => typeof v === 'string' && v in ORDEM_MODO

/**
 * Quando a fase ATUAL começou: anda nas mudanças auditadas da mais nova para a
 * mais antiga, reconstruindo o estado (modo, recorte) antes de cada uma, e para
 * na primeira em que a fase de antes ≠ fase de depois. Mudança que não troca a
 * fase (ajustar o horário do recorte, trocar a persona) não zera a contagem.
 *
 * `atual` é o estado de agora; `mudancas` vêm da mais NOVA para a mais antiga.
 * Devolve null quando nenhuma mudança auditada trocou a fase (configuração
 * anterior à auditoria da P14) — quem chama estima.
 */
export function inicioDaFasePorAuditoria(
  atual: { readonly modoNumero: ModoAgente; readonly recorte: unknown },
  mudancas: readonly MudancaDeConfig[],
): string | null {
  let depois = { modoNumero: atual.modoNumero, recorte: atual.recorte }
  for (const m of mudancas) {
    const antes = m.criacao
      ? { modoNumero: 'desligado' as ModoAgente, recorte: null as unknown }
      : {
        modoNumero: 'modo' in m.antes && ehModo(m.antes['modo']) ? m.antes['modo'] : depois.modoNumero,
        recorte: 'recorte' in m.antes ? m.antes['recorte'] : depois.recorte,
      }
    if (faseDoModo(antes) !== faseDoModo(depois)) return m.em
    depois = antes
  }
  return null
}

// ── playground (pura) ───────────────────────────────────────────────────────

/** Um reinício do playground: quando, quantas decisões a conversa teve e quantas com CRÍTICA que escapou. */
export interface EntradaPlayground {
  readonly em: string
  readonly turnos: number
  readonly criticas: number
}

/**
 * Soma o playground: só as entradas dos últimos 30 dias E depois do `corte`
 * (última publicação de playbook ou mudança de configuração do número — teste
 * de uma versão anterior não vale para a atual). Conversa só conta com ≥ 3
 * decisões; CRÍTICA conta em qualquer conversa depois do corte.
 */
export function somarPlayground(
  entradas: readonly EntradaPlayground[], p: { readonly agora: string; readonly corte: string | null },
): { readonly conversas: number; readonly criticas: number } {
  const ate = Date.parse(p.agora)
  const limite = Math.max(ate - VALIDADE_CONFERENCIA_DIAS * 86_400_000, p.corte ? Date.parse(p.corte) : -Infinity)
  const validas = entradas.filter((e) => Date.parse(e.em) >= limite && Date.parse(e.em) <= ate)
  return {
    conversas: validas.filter((e) => e.turnos >= PLAYGROUND_MIN_DECISOES).length,
    criticas: validas.reduce((n, e) => n + e.criticas, 0),
  }
}

// ── dias pausados pelo teto do tenant (pura) ────────────────────────────────

/** Mudança auditada do teto do tenant (`agente_tenant.modo_maximo`): o teto ANTES dela; null = sem teto. */
export interface MudancaDeTeto {
  readonly em: string
  readonly antes: ModoAgente | null
}

/**
 * Milissegundos de [inicio, agora) em que o teto do tenant segurou o número
 * abaixo do modo dele (kill switch). Esses dias NÃO contam como dias na fase:
 * pausado, o agente não estava sendo testado no modo da fase.
 * `mudancas` vêm da mais NOVA para a mais antiga; `tetoAtual` é o de agora.
 * ⚠️ Dentro de uma fase o modo do número é constante (a fase vem do modo).
 */
export function msPausadosPeloTeto(p: {
  readonly inicio: string; readonly agora: string; readonly modoNumero: ModoAgente
  readonly tetoAtual: ModoAgente | null; readonly mudancas: readonly MudancaDeTeto[]
}): number {
  const ini = Date.parse(p.inicio)
  let fim = Date.parse(p.agora), teto = p.tetoAtual, total = 0
  for (const m of p.mudancas) {
    const em = Date.parse(m.em)
    if (em <= ini) break
    if (em < fim && pausadoPeloTeto(p.modoNumero, teto)) total += fim - em
    fim = Math.min(fim, em)
    teto = m.antes
  }
  if (fim > ini && pausadoPeloTeto(p.modoNumero, teto)) total += fim - ini
  return total
}

// ── alvos (⚠️ PROPOSTA — ADR-031) ───────────────────────────────────────────

/** PROPOSTA. Homologação: conversas douradas (evals P15) sem CRÍTICA. */
export const ALVO_DOURADAS_MIN = 25
/** PROPOSTA. Homologação: conversas no playground sem CRÍTICA. */
export const ALVO_PLAYGROUND_CONVERSAS_MIN = 30
/** Validade de uma conferência de homologação (douradas, smoke, playground). */
export const VALIDADE_CONFERENCIA_DIAS = 30
/** Conversa de playground só conta como testada com ≥ 3 decisões (um "oi" não testa nada). */
export const PLAYGROUND_MIN_DECISOES = 3
/** Teto de entradas guardadas por número (os reinícios de mais de 30 dias são descartados antes). */
export const PLAYGROUND_MAX_ENTRADAS = 500
/** PROPOSTA. Sombra: duração e volume mínimos. */
export const ALVO_SOMBRA_DIAS_UTEIS_MIN = 10
export const ALVO_SOMBRA_TURNOS_MIN = 150
export const ALVO_SOMBRA_CONVERSAS_MIN = 50
/** PROPOSTA. Sombra: fração dos turnos comparados com similaridade ≥ LIMIAR_SIMILARIDADE_SOMBRA (0,6). */
export const ALVO_SIMILARIDADE_SOMBRA_TAXA_MIN = 0.6
/** PROPOSTA. Nota média do juiz (0–5). Só vale com a concordância na meta (ADR-031 §5). */
export const ALVO_NOTA_JUIZ_MIN = 4
/** PROPOSTA. Custo por conversa: R$ 1,50 (sem o custo do juiz, que aparece à parte). */
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
/** PROPOSTA. p95 do cliente falar até a 1ª resposta do agente na sessão. */
export const ALVO_P95_PRIMEIRA_RESPOSTA_MAX_MS = 6_000
/** PROPOSTA. Conversas com handoff ÷ conversas do agente. Abaixo de 10% ele segura o que não devia. */
export const ALVO_HANDOFF_TAXA_MIN = 0.1
export const ALVO_HANDOFF_TAXA_MAX = 0.4
/** PROPOSTA. Conversas com opt-out ÷ conversas do agente. */
export const ALVO_OPT_OUT_TAXA_MAX = 0.01
/** PROPOSTA. Margem de não-inferioridade da conversão: −2 p.p. */
export const ALVO_CONVERSAO_MARGEM = 0.02
/** Conversa só entra na coorte de conversão com ≥ 14 dias (teve tempo de virar pedido). */
export const CONVERSAO_MATURACAO_DIAS = 14
/** Nível do teste de não-inferioridade (unilateral) e poder exigido para julgar. */
export const CONVERSAO_ALFA_UNILATERAL = 0.05
export const CONVERSAO_PODER = 0.8
/** PROPOSTA. Handoffs atendidos dentro do SLA (P18): cumpridos ÷ medidos. */
export const ALVO_SLA_CUMPRIDO_MIN = 0.9

// ── estatística da conversão (pura) ─────────────────────────────────────────

const Z_UNILATERAL_95 = 1.6448536269514722 // Φ⁻¹(0,95)
const Z_PODER_80 = 0.8416212335729143      // Φ⁻¹(0,80)

/** Intervalo de Wilson para uma proporção (x de n), com o z dado. */
export function wilson(x: number, n: number, z = Z_UNILATERAL_95): { readonly inf: number; readonly sup: number } {
  if (n <= 0) return { inf: 0, sup: 1 }
  const p = x / n, z2 = z * z
  const centro = (p + z2 / (2 * n)) / (1 + z2 / n)
  const meia = (z / (1 + z2 / n)) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))
  return { inf: Math.max(0, centro - meia), sup: Math.min(1, centro + meia) }
}

/**
 * Diferença pA − pB com o intervalo de Newcombe (método 10, híbrido de
 * Wilson). Com z = 1,645 o limite inferior é o do IC UNILATERAL de 95%.
 */
export function diferencaNewcombe(
  a: { readonly x: number; readonly n: number }, b: { readonly x: number; readonly n: number }, z = Z_UNILATERAL_95,
): { readonly diferenca: number; readonly inf: number; readonly sup: number } {
  const pa = a.x / a.n, pb = b.x / b.n
  const wa = wilson(a.x, a.n, z), wb = wilson(b.x, b.n, z)
  const d = pa - pb
  return {
    diferenca: d,
    inf: d - Math.sqrt((pa - wa.inf) ** 2 + (wb.sup - pb) ** 2),
    sup: d + Math.sqrt((wa.sup - pa) ** 2 + (pb - wb.inf) ** 2),
  }
}

/**
 * Conversas por coorte para o teste de não-inferioridade ter poder 80% com
 * α = 5% unilateral, supondo diferença real 0 na taxa `p` (a da coorte humana).
 * n = (zα + zβ)² · 2p(1−p) / margem².
 */
export function amostraParaNaoInferioridade(p: number, margem = ALVO_CONVERSAO_MARGEM): number {
  const q = Math.min(Math.max(p, 0.01), 0.99)
  return Math.ceil(((Z_UNILATERAL_95 + Z_PODER_80) ** 2 * 2 * q * (1 - q)) / (margem * margem))
}

// ── medidas ─────────────────────────────────────────────────────────────────

/** Uma medida: o valor, ou indisponível com o motivo (fonte ausente, sem registro, falha). */
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
  /** Conferência registrada da última rodada das douradas (P15). */
  readonly douradas: Medida<{ readonly cenarios: number; readonly criticas: number; readonly em: string; readonly por: string | null }>
  /** Conferência registrada do smoke do provedor (quem declarou e quando). */
  readonly smoke: Medida<{ readonly ok: boolean; readonly em: string; readonly por: string | null }>
  /**
   * Playground (`somarPlayground`): conversas testadas com ≥ 3 decisões e CRÍTICAs que escaparam,
   * só depois do `corte` (última publicação de playbook ou mudança de configuração do número).
   */
  readonly playground: Medida<{ readonly conversas: number; readonly criticas: number; readonly corte: string | null }>
  /** Decisões no modo da fase, na janela (sem silêncio). */
  readonly volume: Medida<{ readonly turnos: number; readonly conversas: number }>
  /** CRÍTICAs que ESCAPARAM (P12, `agente_avaliacao.pior_gravidade`), na janela da fase. */
  readonly criticas: Medida<number>
  /** Nota média do juiz (P12) e quantas avaliações. */
  readonly notaJuiz: Medida<{ readonly media: number | null; readonly avaliadas: number }>
  /** Concordância humano × juiz (P16), uma revisão por conversa na janela inteira. */
  readonly concordancia: Medida<{ readonly valor: number | null; readonly comparaveis: number; readonly falsosNegativosCritica: number }>
  /** Sombra × humano (P13). */
  readonly similaridadeSombra: Medida<{ readonly comparados: number; readonly taxaAcima: number | null }>
  /** Custo por conversa (P6), centavos; null sem conversas. O juiz vem à parte. */
  readonly custoPorConversa: Medida<{ readonly centavos: number | null; readonly conversas: number; readonly juizCentavos: number }>
  /** Turnos com resposta e quantos tiveram número bloqueado (P7). */
  readonly numerosBloqueados: Medida<{ readonly turnos: number; readonly comBloqueio: number }>
  /** Sugestões do assistido (P13). */
  readonly sugestoes: Medida<{
    readonly geradas: number; readonly usadas: number; readonly taxaUso: number | null; readonly taxaSemEdicao: number | null
  }>
  /** p95 do cliente falar até a 1ª mensagem do agente na sessão, ms. */
  readonly latenciaPrimeira: Medida<{ readonly p95Ms: number | null; readonly amostras: number; readonly semMedida: number }>
  readonly handoff: Medida<{ readonly conversas: number; readonly comHandoff: number }>
  /** Opt-out pedido ao agente (P4). */
  readonly optOut: Medida<{ readonly conversas: number; readonly comOptOut: number }>
  /** Conversão em pedido, coortes MADURAS (≥ 14 dias): agente × humano, mesmo número. */
  readonly conversao: Medida<{
    readonly agente: { readonly conversas: number; readonly convertidas: number }
    readonly humano: { readonly conversas: number; readonly convertidas: number }
  }>
  /** Pedidos que o agente levou à confirmação e que depois foram cancelados (APROXIMAÇÃO de "confirmado errado"). */
  readonly pedidosErrados: Medida<{ readonly confirmados: number; readonly cancelados: number }>
  /** SLA do handoff (P18): o mesmo bloco `slaHandoff` de /v1/performance, do número. */
  readonly slaHandoff: Medida<MetricaSlaHandoff>
}

export type FonteMedida = keyof MedidasFase

// ── critérios ───────────────────────────────────────────────────────────────

export interface CriterioFase {
  readonly id: string
  readonly rotulo: string
  /** O alvo legível ("≥ 85% com ≥ 20 revisadas"). */
  readonly alvo: string
  /** O valor medido legível; null quando não há medida nenhuma. */
  readonly valor: string | null
  /** true cumpre, false reprova, null sem medida (fonte ausente ou amostra insuficiente). */
  readonly ok: boolean | null
  /** De onde vem o número (tabela/raia). */
  readonly fonte: string
  readonly indisponivel?: true
  /** Por que não há medida, ou uma observação sobre o valor. */
  readonly motivo?: string
  /** Pede revisão humana, sem reprovar (ex.: pedido desfeito no autônomo amplo). */
  readonly alerta?: string
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
  readonly pendencias: {
    readonly reprovados: readonly string[]
    readonly indisponiveis: readonly string[]
    readonly alertas: readonly string[]
  }
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
/** Pontos percentuais com o sinal de menos tipográfico (−), como os alvos. */
const pp = (x: number) => {
  const v = Math.round(Math.abs(x) * 1000) / 10
  return `${x < 0 && v > 0 ? '−' : ''}${virgula(v.toFixed(1))} p.p.`
}
const fmtData = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`

// ── construção dos critérios ────────────────────────────────────────────────

const FONTE = {
  douradas: 'Conferência das douradas (P15), registrada no painel',
  smoke: 'Conferência do smoke (P15), registrada no painel',
  playground: 'Playground: conversas reiniciadas + a aberta, regras de qualidade (P12)',
  decisao: 'agente_decisao',
  qualidade: 'Qualidade em produção: agente_avaliacao (P12)',
  juiz: 'Juiz amostrado: agente_avaliacao (P12)',
  revisao: 'Revisão humana: agente_revisao (P16)',
  sombra: 'Sombra × humano: agente_decisao.sombra_similaridade (P13)',
  custo: 'Custo por turno: agente_decisao.custo_centavos (P6)',
  numeros: 'Guardrail numérico: agente_decisao (P7)',
  sugestoes: 'Sugestões do assistido: agente_decisao.sugestao_estado (P13)',
  latencia: 'mensagem do cliente → 1ª mensagem do agente na sessão (agente_decisao + mensagem)',
  handoff: 'agente_decisao.desfecho = handoff',
  optOut: 'Gatilho de opt-out: agente_decisao.guardrails (P4)',
  conversao: 'pedido confirmado ou efetivado por conversa, coortes com ≥ 14 dias; humana = respondida por pessoa (régua da P18)',
  pedidos: 'pedido de origem agente: confirmado e depois cancelado (aproximação)',
  sla: 'SLA do handoff: atendimento (P18)',
} as const

/** O que o avaliador de um critério devolve: ok null = sem medida (amostra), com motivo. */
interface Juizo { readonly valor: string | null; readonly ok: boolean | null; readonly motivo?: string; readonly alerta?: string }

type Avaliador = (e: EntradaFase) => CriterioFase

const declarado = (v: { readonly em: string; readonly por: string | null }) =>
  `Declarado ${v.por ? `por ${v.por} ` : ''}em ${fmtData(v.em)} (vale 30 dias).`
const cortePlayground = (corte: string | null) =>
  corte ? `Contam só os testes depois de ${fmtData(corte)} (última publicação do playbook ou mudança na configuração do número).` : 'Contam os testes dos últimos 30 dias.'

function semMedida(id: string, rotulo: string, alvo: string, fonte: string, motivo: string): CriterioFase {
  return { id, rotulo, alvo, valor: null, ok: null, fonte, indisponivel: true, motivo }
}

/** Lê a medida; se faltar ou estiver indisponível, o critério fica sem medida. */
function com<K extends FonteMedida>(
  e: EntradaFase, chave: K, id: string, rotulo: string, alvo: string, fonte: string,
  fn: (v: Extract<MedidasFase[K], { disponivel: true }>['valor']) => Juizo,
): CriterioFase {
  const m = e.medidas[chave]
  if (!m) return semMedida(id, rotulo, alvo, fonte, 'Medida não coletada para esta fase.')
  if (!m.disponivel) return semMedida(id, rotulo, alvo, fonte, m.motivo)
  const r = fn(m.valor as Extract<MedidasFase[K], { disponivel: true }>['valor'])
  return {
    id, rotulo, alvo, valor: r.valor, ok: r.ok, fonte,
    ...(r.ok === null ? { indisponivel: true as const } : {}),
    ...(r.motivo ? { motivo: r.motivo } : {}),
    ...(r.alerta ? { alerta: r.alerta } : {}),
  }
}

/** Sem amostra: sem medida, com o motivo. Nunca reprova. */
const semAmostra = (motivo: string, valor: string | null = null): Juizo => ({ valor, ok: null, motivo })

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
  douradas: (e: EntradaFase) => com(e, 'douradas', 'douradas', 'Conversas douradas sem CRÍTICA', `≥ ${ALVO_DOURADAS_MIN} cenários, 0 CRÍTICA`, FONTE.douradas,
    (v) => ({ valor: `${v.cenarios} cenários, ${v.criticas} CRÍTICA`, ok: v.cenarios >= ALVO_DOURADAS_MIN && v.criticas === 0, motivo: declarado(v) })),
  smoke: (e: EntradaFase) => com(e, 'smoke', 'smoke', 'Smoke do provedor de IA', 'ok', FONTE.smoke,
    (v) => ({ valor: v.ok ? 'ok' : 'falhou', ok: v.ok, motivo: declarado(v) })),
  playgroundVolume: (e: EntradaFase) => com(e, 'playground', 'playground_conversas', 'Conversas testadas no playground',
    `≥ ${ALVO_PLAYGROUND_CONVERSAS_MIN} (com ≥ ${PLAYGROUND_MIN_DECISOES} turnos)`, FONTE.playground,
    (v) => ({ valor: String(v.conversas), ok: v.conversas >= ALVO_PLAYGROUND_CONVERSAS_MIN, motivo: cortePlayground(v.corte) })),
  playgroundCritica: (e: EntradaFase) => com(e, 'playground', 'playground_critica', 'CRÍTICA no playground', '0', FONTE.playground,
    (v) => v.conversas === 0 && v.criticas === 0
      ? semAmostra(`Nenhuma conversa testada no playground ainda. ${cortePlayground(v.corte)}`)
      : { valor: String(v.criticas), ok: v.criticas === 0, motivo: cortePlayground(v.corte) }),
  turnos: (min: number): Avaliador => (e) => com(e, 'volume', 'turnos', 'Turnos na fase', `≥ ${min}`, FONTE.decisao,
    (v) => ({ valor: String(v.turnos), ok: v.turnos >= min })),
  conversas: (min: number): Avaliador => (e) => com(e, 'volume', 'conversas', 'Conversas na fase', `≥ ${min}`, FONTE.decisao,
    (v) => ({ valor: String(v.conversas), ok: v.conversas >= min })),
  similaridade: (e: EntradaFase) => com(e, 'similaridadeSombra', 'similaridade_sombra', 'Sombra parecida com o humano',
    `≥ ${formatarPct(ALVO_SIMILARIDADE_SOMBRA_TAXA_MIN)} dos turnos com similaridade ≥ ${virgula(String(LIMIAR_SIMILARIDADE_SOMBRA))}`, FONTE.sombra,
    (v) => v.comparados === 0 || v.taxaAcima === null
      ? semAmostra('Sem resposta humana depois de um turno de sombra na janela — nada para comparar.')
      : { valor: `${formatarPct(v.taxaAcima)} de ${v.comparados}`, ok: v.taxaAcima >= ALVO_SIMILARIDADE_SOMBRA_TAXA_MIN }),
  concordancia: (e: EntradaFase) => com(e, 'concordancia', 'concordancia', 'Concordância humano × juiz',
    `≥ ${formatarPct(META_CONCORDANCIA)} com ≥ ${MIN_REVISADAS_CONCORDANCIA} conversas revisadas e 0 CRÍTICA não vista`, FONTE.revisao,
    (v) => {
      // CRÍTICA que o juiz não viu reprova com qualquer amostra: é o caso que a revisão existe para pegar.
      if (v.falsosNegativosCritica > 0) return { valor: `${v.falsosNegativosCritica} CRÍTICA não vista pelo juiz`, ok: false }
      if (v.comparaveis < MIN_REVISADAS_CONCORDANCIA || v.valor === null) {
        return semAmostra(`Amostra insuficiente: ${v.comparaveis} de ${MIN_REVISADAS_CONCORDANCIA} conversas revisadas comparáveis.`,
          v.valor === null ? null : `${formatarPct(v.valor)} em ${v.comparaveis}`)
      }
      return { valor: `${formatarPct(v.valor)} em ${v.comparaveis}`, ok: v.valor >= META_CONCORDANCIA }
    }),
  nota: (e: EntradaFase): CriterioFase => {
    const conc = C.concordancia(e)
    return com(e, 'notaJuiz', 'nota_juiz', 'Nota média do juiz', `≥ ${virgula(ALVO_NOTA_JUIZ_MIN.toFixed(1))} (com concordância na meta)`, FONTE.juiz,
      (v) => {
        if (v.media === null || v.avaliadas === 0) return semAmostra('Nenhuma conversa avaliada pelo juiz na janela.')
        const valor = `${fmtNota(v.media)} em ${v.avaliadas}`
        // ADR-031 §5: sem concordância na meta a nota não vale — nem para aprovar, nem para reprovar.
        if (conc.ok !== true) return semAmostra('A nota do juiz só vale com a concordância humana na meta (ADR-031 §5).', valor)
        return { valor, ok: v.media >= ALVO_NOTA_JUIZ_MIN }
      })
  },
  custo: (e: EntradaFase) => com(e, 'custoPorConversa', 'custo_conversa', 'Custo por conversa', `≤ ${formatarCentavos(ALVO_CUSTO_CONVERSA_MAX_CENTAVOS)}`, FONTE.custo,
    (v) => {
      const juiz = `Juiz à parte: ${formatarCentavos(v.juizCentavos)} na janela — é custo de MEDIR a qualidade (amostra), não de atender, por isso fica fora do alvo.`
      if (v.centavos === null) return semAmostra('Nenhuma conversa na janela.')
      return { valor: formatarCentavos(v.centavos), ok: v.centavos <= ALVO_CUSTO_CONVERSA_MAX_CENTAVOS, motivo: juiz }
    }),
  numeros: (e: EntradaFase) => com(e, 'numerosBloqueados', 'numeros_bloqueados', 'Turnos com número bloqueado', `≤ ${formatarPct(ALVO_NUMEROS_BLOQUEADOS_TAXA_MAX)}`, FONTE.numeros,
    (v) => {
      const t = taxa(v.comBloqueio, v.turnos)
      return t === null ? semAmostra('Nenhum turno com resposta na janela.') : { valor: `${formatarPct(t)} (${v.comBloqueio} de ${v.turnos})`, ok: t <= ALVO_NUMEROS_BLOQUEADOS_TAXA_MAX }
    }),
  sugestoesVolume: (e: EntradaFase) => com(e, 'sugestoes', 'sugestoes', 'Sugestões geradas', `≥ ${ALVO_ASSISTIDO_SUGESTOES_MIN}`, FONTE.sugestoes,
    (v) => ({ valor: String(v.geradas), ok: v.geradas >= ALVO_ASSISTIDO_SUGESTOES_MIN })),
  uso: (e: EntradaFase) => com(e, 'sugestoes', 'uso_sugestao', 'Sugestões usadas pelo vendedor', `≥ ${formatarPct(ALVO_USO_TAXA_MIN)}`, FONTE.sugestoes,
    (v) => v.taxaUso === null ? semAmostra('Nenhuma sugestão gerada na janela.') : { valor: `${formatarPct(v.taxaUso)} de ${v.geradas}`, ok: v.taxaUso >= ALVO_USO_TAXA_MIN }),
  semEdicao: (e: EntradaFase) => com(e, 'sugestoes', 'sem_edicao', 'Enviadas sem edição',
    `≥ ${formatarPct(ALVO_SEM_EDICAO_TAXA_MIN)} com ≥ ${ALVO_SEM_EDICAO_USADAS_MIN} enviadas`, FONTE.sugestoes,
    (v) => {
      const valor = v.taxaSemEdicao === null ? null : `${formatarPct(v.taxaSemEdicao)} de ${v.usadas}`
      if (v.usadas < ALVO_SEM_EDICAO_USADAS_MIN || v.taxaSemEdicao === null) {
        return semAmostra(`Amostra insuficiente: ${v.usadas} de ${ALVO_SEM_EDICAO_USADAS_MIN} sugestões enviadas.`, valor)
      }
      return { valor, ok: v.taxaSemEdicao >= ALVO_SEM_EDICAO_TAXA_MIN }
    }),
  diasCorridos: (min: number): Avaliador => (e) => ({
    id: 'dias', rotulo: 'Tempo na fase', alvo: `≥ ${min} dias`, valor: `${e.diasCorridos} ${e.diasCorridos === 1 ? 'dia' : 'dias'}`,
    ok: e.diasCorridos >= min, fonte: 'Auditoria da configuração do modo (P14)',
  }),
  p95: (e: EntradaFase) => com(e, 'latenciaPrimeira', 'p95_primeira', 'p95 do cliente falar até a 1ª resposta', `≤ ${fmtMs(ALVO_P95_PRIMEIRA_RESPOSTA_MAX_MS)}`, FONTE.latencia,
    (v) => v.p95Ms === null || v.amostras === 0
      ? semAmostra('Nenhuma 1ª resposta enviada pelo agente na janela.')
      : { valor: `${fmtMs(v.p95Ms)} (${v.amostras} sessões)`, ok: v.p95Ms <= ALVO_P95_PRIMEIRA_RESPOSTA_MAX_MS,
        motivo: 'Medido da 1ª mensagem do cliente que o turno respondeu até a 1ª mensagem do agente — inclui a espera da fila (debounce).'
          + (v.semMedida > 0 ? ` ${v.semMedida} ${v.semMedida === 1 ? 'sessão ficou' : 'sessões ficaram'} sem medida (mensagens não encontradas).` : '') }),
  handoff: (e: EntradaFase) => com(e, 'handoff', 'handoff', 'Conversas passadas para humano',
    `entre ${formatarPct(ALVO_HANDOFF_TAXA_MIN)} e ${formatarPct(ALVO_HANDOFF_TAXA_MAX)}`, FONTE.handoff,
    (v) => {
      const t = taxa(v.comHandoff, v.conversas)
      return t === null ? semAmostra('Nenhuma conversa do agente na janela.') : { valor: `${formatarPct(t)} (${v.comHandoff} de ${v.conversas})`, ok: t >= ALVO_HANDOFF_TAXA_MIN && t <= ALVO_HANDOFF_TAXA_MAX }
    }),
  optOut: (e: EntradaFase) => com(e, 'optOut', 'opt_out', 'Opt-out nas conversas do agente', `≤ ${formatarPct(ALVO_OPT_OUT_TAXA_MAX)}`, FONTE.optOut,
    (v) => {
      const t = taxa(v.comOptOut, v.conversas)
      return t === null ? semAmostra('Nenhuma conversa do agente na janela.') : { valor: `${formatarPct(t)} (${v.comOptOut} de ${v.conversas})`, ok: t <= ALVO_OPT_OUT_TAXA_MAX }
    }),
  conversao: (e: EntradaFase) => com(e, 'conversao', 'conversao', 'Conversão em pedido × coorte humana',
    `não-inferior: limite inferior do IC unilateral de 95% da diferença ≥ −${pp(ALVO_CONVERSAO_MARGEM)}`, FONTE.conversao,
    (v) => julgarConversao(v.agente, v.humano)),
  pedidos: (amplo: boolean): Avaliador => (e) => com(e, 'pedidosErrados', 'pedido_errado', 'Pedido confirmado errado', '0', FONTE.pedidos,
    (v) => {
      const aproximacao = 'Aproximação: pedido do agente que o cliente confirmou e alguém cancelou depois. O domínio não registra "erro do pedido"; o cancelamento é o sinal que existe.'
      if (v.confirmados === 0) return semAmostra('Nenhum pedido confirmado pelo agente na janela.')
      const valor = `${v.cancelados} de ${v.confirmados} confirmados`
      if (v.cancelados === 0) return { valor, ok: true, motivo: aproximacao }
      // No amplo é sinal para revisar, não reprovação: cancelamento tem muitas causas (o cliente desistiu, o ERP recusou).
      if (amplo) return { valor, ok: true, motivo: aproximacao, alerta: `Revise ${v.cancelados === 1 ? 'o pedido cancelado' : `os ${v.cancelados} pedidos cancelados`} depois da confirmação.` }
      return { valor, ok: false, motivo: aproximacao }
    }),
  sla: (e: EntradaFase) => com(e, 'slaHandoff', 'sla_handoff', 'SLA do handoff cumprido', `≥ ${formatarPct(ALVO_SLA_CUMPRIDO_MIN)}`, FONTE.sla,
    (v) => {
      if (v.medidos === 0) return semAmostra(v.pendentes > 0 ? `Nenhum handoff com SLA decidido na janela (${v.pendentes} ainda no prazo).` : 'Nenhum handoff com SLA na janela.')
      const t = v.cumpridos / v.medidos // sem arredondar: 89,6% não é 90%
      return { valor: `${formatarPct(t)} de ${v.medidos}${v.pendentes ? ` · ${v.pendentes} em aberto` : ''}`, ok: t >= ALVO_SLA_CUMPRIDO_MIN }
    }),
}

const VIES_DE_SELECAO = 'Coortes não aleatorizadas: o agente atende o recorte (horário, segmento) e o humano o resto — clientes e momentos diferentes (viés de seleção). Leia como indício, não como prova.'

/**
 * Não-inferioridade da conversão: Newcombe/Wilson, coortes maduras.
 *
 *   coorte vazia                  → sem medida (não há leitura nenhuma);
 *   intervalo inteiro < −margem   → REPROVA (inferioridade clara, com qualquer n);
 *   n abaixo do poder de 80%      → cumpre COM ALERTA: "amostra sem poder; leitura
 *                                   indicativa" — no B2B o n do poder (~5 mil por
 *                                   coorte) quase nunca chega, e bloquear até lá
 *                                   seria nunca avançar;
 *   n com poder                   → cumpre se o limite inferior ≥ −margem.
 */
export function julgarConversao(
  a: { readonly conversas: number; readonly convertidas: number }, h: { readonly conversas: number; readonly convertidas: number },
): Juizo {
  if (a.conversas === 0 || h.conversas === 0) {
    return semAmostra(`Sem coorte madura (conversas com ≥ ${CONVERSAO_MATURACAO_DIAS} dias) ${a.conversas === 0 ? 'do agente' : 'humana'} na janela. ${VIES_DE_SELECAO}`)
  }
  const pa = a.convertidas / a.conversas, ph = h.convertidas / h.conversas
  const ic = diferencaNewcombe({ x: a.convertidas, n: a.conversas }, { x: h.convertidas, n: h.conversas })
  const valor = `agente ${formatarPct(pa)} (n ${a.conversas}) × humano ${formatarPct(ph)} (n ${h.conversas}); diferença ${pp(ic.diferenca)}, limite inferior ${pp(ic.inf)}`
  const margem = pp(ALVO_CONVERSAO_MARGEM)
  if (ic.sup < -ALVO_CONVERSAO_MARGEM) {
    return { valor, ok: false, motivo: `O intervalo inteiro fica abaixo de −${margem}: inferioridade clara. ${VIES_DE_SELECAO}` }
  }
  const precisa = amostraParaNaoInferioridade(ph)
  if (a.conversas < precisa || h.conversas < precisa) {
    return {
      valor, ok: true, motivo: VIES_DE_SELECAO,
      alerta: `Amostra sem poder para −${margem}; leitura indicativa (limite inferior ${pp(ic.inf)}, n ${a.conversas} × ${h.conversas}; o poder de 80% pede ~${precisa} por coorte).`,
    }
  }
  return { valor, ok: ic.inf >= -ALVO_CONVERSAO_MARGEM, motivo: VIES_DE_SELECAO }
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
    C.p95, C.handoff, C.optOut, C.conversao, C.pedidos(false), C.sla,
  ],
  autonomo_amplo: [
    criticaZero('critica', `CRÍTICA nos últimos ${ALVO_AMPLO_JANELA_DIAS} dias`),
    C.p95, C.handoff, C.optOut, C.conversao, C.pedidos(true), C.sla,
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
  const alertas = criterios.filter((c) => c.alerta).map((c) => c.id)
  const tudoOk = reprovados.length === 0 && indisponiveis.length === 0
  const proxima = proximaFase(e.fase)
  let recomendacao: RecomendacaoFase
  let voltarPara: FaseAgente | null = null
  if (e.fase === 'autonomo_amplo') {
    // Amplo é permanente: revisão a cada 30 dias. Só REPROVAÇÃO manda voltar —
    // falta de amostra ou fonte fora não (mantém e mostra o que falta medir).
    if (reprovados.length > 0) { recomendacao = 'voltar'; voltarPara = faseAnterior(e.fase) } else recomendacao = 'manter'
  } else {
    recomendacao = tudoOk ? 'avancar' : 'manter'
  }
  return {
    fase: e.fase, proximaFase: proxima, criterios,
    podeAvancar: proxima !== null && tudoOk,
    recomendacao, voltarPara,
    pendencias: { reprovados, indisponiveis, alertas },
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

// ── conferência de homologação (douradas e smoke) ───────────────────────────

export const ITENS_HOMOLOGACAO = ['douradas', 'smoke', 'playground'] as const
export type ItemHomologacao = (typeof ITENS_HOMOLOGACAO)[number]

/**
 * POST /v1/agente/go-live/conferencia — admin registra a última rodada das
 * douradas (cenários e CRÍTICAs) ou do smoke (ok). O playground NÃO entra
 * aqui: é medido pelo próprio sistema nos reinícios da simulação.
 */
export const corpoConferenciaGoLive = z.discriminatedUnion('item', [
  z.object({
    item: z.literal('douradas'),
    canalId: z.string().uuid(),
    cenarios: z.number().int().min(1).max(10_000),
    criticas: z.number().int().min(0).max(10_000),
  }).strict().refine((v) => v.criticas <= v.cenarios, { message: 'não pode haver mais CRÍTICAs que cenários', path: ['criticas'] }),
  z.object({ item: z.literal('smoke'), canalId: z.string().uuid(), ok: z.boolean() }).strict(),
])
export type CorpoConferenciaGoLive = z.input<typeof corpoConferenciaGoLive>

// ── contrato HTTP ───────────────────────────────────────────────────────────

/** GET /v1/agente/go-live?canalId */
export interface GoLiveDto extends ResultadoFase {
  readonly canalId: string
  readonly rotuloFase: string
  /** Dias corridos completos desde o início da fase, SEM os dias pausados pelo teto. */
  readonly dias: number
  readonly diasUteis: number
  /** ISO; null quando não há registro nenhum. */
  readonly inicioFase: string | null
  /** true = sem mudança auditada que trocou a fase; o início foi estimado pela 1ª decisão no modo. */
  readonly inicioEstimado: boolean
  /** Janela das medidas, em dias para trás. */
  readonly janelaDias: number
  /** `agente_config.modo` do número. */
  readonly modoNumero: ModoAgente
  /** O teto do tenant segura o número abaixo do modo dele (kill switch): a fase não muda. */
  readonly pausadoPeloTeto: boolean
  /** Dias (1 casa) em que o teto pausou o número desde o início da fase — descontados de `dias`. */
  readonly diasPausados: number
  /** Quem pede pode registrar conferência (admin): a tela só mostra o formulário então. */
  readonly podeConferir: boolean
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
