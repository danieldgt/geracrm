import { z } from 'zod'
import { MODOS_AGENTE, type ModoAgente } from './agente-vendedor.js'
import type { CodigoSegmentoRfv } from './rfv.js'

/**
 * MODO EFETIVO — RECORTE, "O MAIS RESTRITIVO VENCE" E CONFIRMAÇÃO DIGITADA
 * (ADR-028, raia P14 de docs/plano-port-playbook-am.md).
 *
 * Três níveis dizem em que modo o agente pode atuar num turno:
 *
 *   tenant  (`agente_tenant.modo_maximo`) — o kill switch geral;
 *   número  (`agente_config.modo`);
 *   recorte (`agente_config.recorte`)     — horário e segmentos RFV em que o
 *                                            modo do número vale; fora dele o
 *                                            modo CAI para `foraDoRecorte`.
 *
 * Vence o mais restritivo, na ordem `desligado < sombra < assistido < autonomo`.
 * O nível de baixo restringe, nunca afrouxa o de cima. ⚠️ Decisão PURA: quem
 * chama traz os fatos (teto, momento local, segmento do contato); aqui não há
 * relógio, fuso nem banco — por isso a tabela de testes cobre tudo sem I/O.
 *
 * ⚠️ Vocabulário (ADR-028): "assistido" aqui é SUGERE. O "assistido" da AM
 *    (responde só dentro do recorte) é o nosso `autonomo` com recorte.
 *
 * TypeScript puro: consumido pela API (pipeline), pelo console (tela) e pelo app.
 */

/** Ordem de restrição: menor = mais restritivo. */
export const ORDEM_MODO: Readonly<Record<ModoAgente, number>> = { desligado: 0, sombra: 1, assistido: 2, autonomo: 3 }

/** O mais restritivo de dois modos. */
export function maisRestritivo(a: ModoAgente, b: ModoAgente): ModoAgente {
  return ORDEM_MODO[a] <= ORDEM_MODO[b] ? a : b
}

// ── recorte ─────────────────────────────────────────────────────────────────

/**
 * Segmentos aceitos no recorte: os do RFV (`classificarRfv`) e `sem-historico`
 * — o contato que ainda não tem compra nas métricas (o lead novo, que no B2B é
 * justamente quem mais se quer deixar com o humano ou com o robô).
 */
export const SEGMENTO_SEM_HISTORICO = 'sem-historico' as const
export const SEGMENTOS_RECORTE = [
  'cliente-recente', 'cliente-fiel', 'nao-perder', 'em-risco', 'semi-perdido', 'hibernando', SEGMENTO_SEM_HISTORICO,
] as const satisfies readonly (CodigoSegmentoRfv | typeof SEGMENTO_SEM_HISTORICO)[]
export type SegmentoRecorte = (typeof SEGMENTOS_RECORTE)[number]

export const ROTULO_SEGMENTO_RECORTE: Readonly<Record<SegmentoRecorte, string>> = {
  'cliente-recente': 'Cliente novo',
  'cliente-fiel': 'Em dia',
  'nao-perder': 'Na hora da recompra',
  'em-risco': 'Em risco',
  'semi-perdido': 'Sumindo',
  'hibernando': 'Hibernando',
  'sem-historico': 'Sem compra registrada',
}

/** Para onde o modo cai fora do recorte. `autonomo` não entra: fora do recorte nunca SOBE. */
export const MODOS_FORA_DO_RECORTE = ['desligado', 'sombra', 'assistido'] as const
export type ModoForaDoRecorte = (typeof MODOS_FORA_DO_RECORTE)[number]

/** Dias no formato do horário de atendimento do canal (`expediente.ts`). */
export const DIAS_RECORTE = ['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom'] as const
export type DiaRecorte = (typeof DIAS_RECORTE)[number]
const DIA_POR_ISO: Readonly<Record<number, DiaRecorte>> = { 1: 'seg', 2: 'ter', 3: 'qua', 4: 'qui', 5: 'sex', 6: 'sab', 7: 'dom' }

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const faixaRecorte = z.object({
  de: z.string().regex(HHMM, 'use HH:MM'),
  ate: z.string().regex(HHMM, 'use HH:MM'),
}).strict().refine((f) => f.de !== f.ate, { message: 'início e fim iguais' })

/**
 * Horário do recorte — o MESMO formato do horário de atendimento do canal:
 * `{ seg: {de, ate} | null, … }`. Dia ausente ou `null` = fora o dia todo.
 * Faixa que vira a meia-noite (22:00–02:00) vale.
 */
export const horarioRecorte = z.object({
  seg: faixaRecorte.nullable().optional(), ter: faixaRecorte.nullable().optional(),
  qua: faixaRecorte.nullable().optional(), qui: faixaRecorte.nullable().optional(),
  sex: faixaRecorte.nullable().optional(), sab: faixaRecorte.nullable().optional(),
  dom: faixaRecorte.nullable().optional(),
}).strict().refine((h) => DIAS_RECORTE.some((d) => !!h[d]), { message: 'marque ao menos um dia com horário' })
export type HorarioRecorte = z.output<typeof horarioRecorte>

/**
 * Como o FERIADO do número conta para o recorte (decisão (r) do plano-port §4):
 *   `fora`   — feriado é fora do horário do recorte o dia inteiro (padrão: "a equipe não está de olho");
 *   `dentro` — feriado é DENTRO do recorte o dia inteiro (cobre "autônomo fora do expediente").
 */
export const FERIADO_RECORTE = ['fora', 'dentro'] as const
export type FeriadoRecorte = (typeof FERIADO_RECORTE)[number]

export const recorteAgente = z.object({
  /** null = qualquer hora. */
  horario: horarioRecorte.nullable().default(null),
  /** Feriado conta como fora (padrão) ou dentro do recorte. Recorte antigo sem o campo = 'fora'. */
  feriado: z.enum(FERIADO_RECORTE).default('fora'),
  /** Vazio = todos os segmentos. */
  segmentosRfv: z.array(z.enum(SEGMENTOS_RECORTE)).max(SEGMENTOS_RECORTE.length).default([]),
  foraDoRecorte: z.enum(MODOS_FORA_DO_RECORTE).default('sombra'),
}).strict()
export type RecorteAgente = z.output<typeof recorteAgente>

/** O recorte restringe alguma coisa? (sem horário e sem segmento = é como não ter.) */
export function recorteRestringe(r: RecorteAgente | null): boolean {
  return !!r && (r.horario !== null || r.segmentosRfv.length > 0)
}

/** Momento LOCAL no fuso do tenant: 1 (segunda) … 7 (domingo) e "HH:MM". */
export interface MomentoLocal {
  readonly diaIso: number
  readonly hora: string
  /** Hoje é feriado para o tenant? Ausente = não. */
  readonly feriado?: boolean | undefined
}

/**
 * Dentro do horário do recorte? `null` = qualquer hora.
 *
 * ⚠️ CONVENÇÃO da faixa que cruza a meia-noite (a MESMA do `expediente.ts`): a
 *    faixa de um dia vale nas horas DAQUELE dia local. `seg 22:00–02:00` cobre
 *    seg 00:00–02:00 e seg 22:00–24:00; a madrugada de terça é regida pela faixa
 *    de TERÇA, não pela de segunda. Quem quer "segunda à noite até 2h de terça"
 *    declara `seg 22:00–23:59` e `ter 00:00–02:00` (ou a faixa cruzada nos dois dias).
 *
 * ⚠️ FERIADO (`m.feriado`) conta como FORA do horário por padrão: o recorte por
 *    horário é "quando a equipe está de olho"; feriado não é. Com
 *    `feriado = 'dentro'` o feriado é DENTRO o dia inteiro ("autônomo fora do expediente").
 */
export function dentroDoHorarioRecorte(h: HorarioRecorte | null, m: MomentoLocal, feriado: FeriadoRecorte = 'fora'): boolean {
  if (!h) return true
  if (m.feriado) return feriado === 'dentro'
  const faixa = h[DIA_POR_ISO[m.diaIso] ?? 'seg']
  if (!faixa) return false
  // Comparação lexicográfica de "HH:MM" — o formato é fixo (validado no schema).
  return faixa.de < faixa.ate
    ? m.hora >= faixa.de && m.hora < faixa.ate
    : m.hora >= faixa.de || m.hora < faixa.ate   // cruza a meia-noite
}

// ── decisão ─────────────────────────────────────────────────────────────────

export type ParteForaDoRecorte = 'horario' | 'segmento'
export type OrigemModo = 'numero' | 'tenant' | 'recorte'

export interface EntradaDecisaoModo {
  /** `agente_tenant.modo_maximo`; null = sem teto. */
  readonly modoTenant: ModoAgente | null
  readonly modoNumero: ModoAgente
  /**
   * `agente_config.recorte` CRU (o que está no banco). Inválido = trata como
   * FORA do recorte: errar para o lado restritivo.
   */
  readonly recorte: unknown
  readonly momento: MomentoLocal
  /**
   * Segmento do contato. `undefined` = não se sabe AQUI (a tela, sem contato):
   * a parte de segmento não é avaliada. `null` não existe — sem métrica é
   * `sem-historico`.
   */
  readonly segmento?: SegmentoRecorte | undefined
}

export interface DecisaoModo {
  readonly modo: ModoAgente
  /** De onde veio o modo efetivo: o próprio número, o teto do tenant ou o recorte. */
  readonly origem: OrigemModo
  /**
   * Código da restrição (vai como marca `modo-efetivo` em `agente_decisao`);
   * null = o modo do número valeu.
   */
  readonly motivo: string | null
  /** O que ficou fora do recorte (mesmo quando não rebaixou: informativo). */
  readonly foraDoRecorte: readonly ParteForaDoRecorte[]
  /** O recorte gravado não passou no schema. */
  readonly recorteInvalido: boolean
}

/**
 * O modo efetivo: o mais restritivo entre tenant, número e recorte.
 *
 * ⚠️ Empate entre tenant e recorte credita o TENANT (o nível de cima): é quem
 *    precisa ser desfeito primeiro para o número voltar ao modo dele.
 */
export function decidirModoEfetivo(e: EntradaDecisaoModo): DecisaoModo {
  const tetoTenant = e.modoTenant ?? 'autonomo'

  // Recorte: fora dele, o modo cai para `foraDoRecorte`.
  let tetoRecorte: ModoAgente = 'autonomo'
  const fora: ParteForaDoRecorte[] = []
  let recorteInvalido = false
  if (e.recorte !== null && e.recorte !== undefined) {
    const p = recorteAgente.safeParse(e.recorte)
    if (!p.success) {
      recorteInvalido = true
      tetoRecorte = 'sombra'
    } else {
      const r = p.data
      if (!dentroDoHorarioRecorte(r.horario, e.momento, r.feriado)) fora.push('horario')
      if (r.segmentosRfv.length > 0 && e.segmento !== undefined && !r.segmentosRfv.includes(e.segmento)) fora.push('segmento')
      if (fora.length > 0) tetoRecorte = r.foraDoRecorte
    }
  }

  const modo = maisRestritivo(e.modoNumero, maisRestritivo(tetoTenant, tetoRecorte))
  if (modo === e.modoNumero) {
    return { modo, origem: 'numero', motivo: null, foraDoRecorte: fora, recorteInvalido }
  }
  if (ORDEM_MODO[tetoTenant] <= ORDEM_MODO[tetoRecorte]) {
    return { modo, origem: 'tenant', motivo: 'teto_do_tenant', foraDoRecorte: fora, recorteInvalido }
  }
  const motivo = recorteInvalido ? 'recorte_invalido' : `fora_do_recorte_${fora.join('_')}`
  return { modo, origem: 'recorte', motivo, foraDoRecorte: fora, recorteInvalido }
}

// ── confirmação digitada ────────────────────────────────────────────────────

/** Modos que valem confirmação digitada: soltar o agente de vez ou desligá-lo (ADR-028 §5). */
export const MODOS_COM_CONFIRMACAO: readonly ModoAgente[] = ['autonomo', 'desligado']

/**
 * A troca pede confirmação? Só quando MUDA para um modo da lista. Sem modo
 * atual (número nunca configurado) conta como `desligado` — salvar desligado a
 * primeira vez não é desligar nada.
 */
export function exigeConfirmacao(atual: ModoAgente | null, novo: ModoAgente): boolean {
  return novo !== (atual ?? 'desligado') && MODOS_COM_CONFIRMACAO.includes(novo)
}

/** Sem acento, sem caixa, sem espaço nas pontas. */
export function normalizarConfirmacao(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase()
}

/** O texto digitado confere com o modo? "Autônomo", "AUTONOMO" e " autonomo " conferem com `autonomo`. */
export function confirmacaoConfere(digitado: string | null | undefined, modo: ModoAgente): boolean {
  return typeof digitado === 'string' && normalizarConfirmacao(digitado) === normalizarConfirmacao(modo)
}

/** O que a pessoa tem de digitar para confirmar (o nome do modo, sem acento). */
export function textoDeConfirmacao(modo: ModoAgente): string {
  return normalizarConfirmacao(modo)
}

/** Guarda de tipo para ler `modo_maximo` e afins do banco. */
export function ehModoAgente(v: unknown): v is ModoAgente {
  return typeof v === 'string' && (MODOS_AGENTE as readonly string[]).includes(v)
}
