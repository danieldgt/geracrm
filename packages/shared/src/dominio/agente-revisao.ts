/**
 * REVISÃO HUMANA E CONCORDÂNCIA (ADR-031 §5, raia P16) — o lado puro.
 * TypeScript puro: consumido pela API (rotas de revisão), pelo console (tela
 * de revisão) e pela P19 (critério de fase "concordância ≥ 85% com ≥ 20").
 *
 *   1. A AMOSTRA da semana é a da P12 (`ordenarAmostraSemanal`): 20 conversas
 *      por número — todas as CRÍTICAs, ALTA ou nota ≤ 3 até 8, aleatórias
 *      estáveis. A revisão grava sobre UMA avaliação de cada conversa.
 *   2. O revisor dá nota 0–5 por critério da rubrica, a gravidade que viu
 *      (ou nenhuma), um veredito e — se houver ação — decisão, responsável e prazo.
 *   3. CONCORDA quando |nota do juiz − nota humana| ≤ 1 em CADA critério e a
 *      classe de gravidade é a mesma ("nenhuma" é uma classe). Sem nota do
 *      juiz, a revisão não é comparável (não entra no denominador).
 *   4. A concordância da semana por número é concordantes ÷ comparáveis.
 *      Meta ≥ 85% com ≥ 20 comparáveis (ADR-031); abaixo disso, a nota do juiz
 *      não vale como critério de fase.
 *
 * ⚠️ Em sombra a revisão é do texto DECIDIDO (a sugestão), não do que o
 *    vendedor editou e enviou — é ele que o juiz e as regras avaliaram.
 */
import { z } from 'zod'
import {
  CRITERIOS_RUBRICA, type CriterioRubrica, type GravidadeQualidade, type MotivoAmostra, type OrigemAvaliacao,
  type ViolacaoQualidade,
} from './agente-qualidade.js'

// ── vocabulário ─────────────────────────────────────────────────────────────

/** ok = enviaria assim; ajustar = enviaria com edição leve; grave = não poderia sair. */
export const VEREDITOS_REVISAO = ['ok', 'ajustar', 'grave'] as const
export type VereditoRevisao = (typeof VEREDITOS_REVISAO)[number]

export const ROTULO_VEREDITO: Readonly<Record<VereditoRevisao, string>> = {
  ok: 'Ok — enviaria assim',
  ajustar: 'Ajustar — enviaria com edição leve',
  grave: 'Grave — não poderia sair',
}

/** O que fazer com o achado (procedimento da AM, §5, adaptado ao B2B). */
export const DECISOES_REVISAO = [
  'nenhuma', 'ajustar_prompt', 'nova_regra', 'falso_positivo', 'calibrar_juiz', 'orientar_equipe', 'recuar_modo',
] as const
export type DecisaoRevisao = (typeof DECISOES_REVISAO)[number]

export const ROTULO_DECISAO: Readonly<Record<DecisaoRevisao, string>> = {
  nenhuma: 'Nada a fazer',
  ajustar_prompt: 'Ajustar o roteiro/instruções do agente',
  nova_regra: 'Criar regra de qualidade (ou caso de teste)',
  falso_positivo: 'Falso positivo das regras (ajustar a regra)',
  calibrar_juiz: 'Calibrar o juiz (rubrica/instrução)',
  orientar_equipe: 'Orientar o vendedor que usou a sugestão',
  recuar_modo: 'Recuar o modo do número (ex.: autônomo → assistido)',
}

/** Classe de gravidade: as três gravidades e "nenhuma" (null). */
export type ClasseGravidade = GravidadeQualidade | 'nenhuma'
export function classeGravidade(g: GravidadeQualidade | null | undefined): ClasseGravidade {
  return g === 'CRITICA' || g === 'ALTA' || g === 'MEDIA' ? g : 'nenhuma'
}

/** Meta de concordância (ADR-031) e o mínimo de revisões comparáveis para ela valer. */
export const META_CONCORDANCIA = 0.85
export const MIN_REVISADAS_CONCORDANCIA = 20
/** Diferença máxima entre a nota do juiz e a humana num critério. */
export const TOLERANCIA_NOTA = 1
export const MAX_RESPONSAVEL = 120
export const MAX_OBSERVACAO = 1000

// ── concordância (pura) ─────────────────────────────────────────────────────

export type NotasHumanas = Readonly<Record<CriterioRubrica, number>>
/** Notas do juiz; critério ausente = não avaliado. */
export type NotasDoJuiz = Readonly<Partial<Record<CriterioRubrica, number>>>

export interface EntradaConcordancia {
  /** Notas do juiz (0–5); null = a avaliação não tem nota do juiz. */
  readonly notasLlm: NotasDoJuiz | null
  readonly notasHumanas: NotasHumanas
  /** Pior gravidade que o sistema (regras) registrou na conversa naquela semana. */
  readonly gravidadeSistema: GravidadeQualidade | null
  readonly gravidadeHumana: GravidadeQualidade | null
}

export interface ResultadoConcordancia {
  /** Por critério: concorda? null = o juiz não deu nota neste critério. */
  readonly porCriterio: Readonly<Record<CriterioRubrica, boolean | null>>
  readonly gravidade: boolean
  /** Só é comparável com nota do juiz em TODOS os critérios. */
  readonly comparavel: boolean
  /** null = não comparável. */
  readonly concorda: boolean | null
  /** O humano viu CRÍTICA e o sistema não: bloqueia avançar de fase mesmo com concordância alta. */
  readonly falsoNegativoCritica: boolean
}

export function concordaCriterio(llm: number, humano: number): boolean {
  return Math.abs(llm - humano) <= TOLERANCIA_NOTA
}

/** A regra do ADR-031: |LLM − humano| ≤ 1 em cada critério E mesma classe de gravidade. Pura. */
export function calcularConcordancia(e: EntradaConcordancia): ResultadoConcordancia {
  const porCriterio = {} as Record<CriterioRubrica, boolean | null>
  let comparavel = e.notasLlm !== null
  for (const c of CRITERIOS_RUBRICA) {
    const llm = e.notasLlm?.[c]
    if (typeof llm !== 'number' || !Number.isFinite(llm)) { porCriterio[c] = null; comparavel = false; continue }
    porCriterio[c] = concordaCriterio(llm, e.notasHumanas[c])
  }
  const gravidade = classeGravidade(e.gravidadeSistema) === classeGravidade(e.gravidadeHumana)
  const concorda = comparavel ? gravidade && CRITERIOS_RUBRICA.every((c) => porCriterio[c] === true) : null
  return {
    porCriterio, gravidade, comparavel, concorda,
    falsoNegativoCritica: e.gravidadeHumana === 'CRITICA' && e.gravidadeSistema !== 'CRITICA',
  }
}

/** Uma revisão gravada, só o que a soma precisa. */
export interface RevisaoParaSomar {
  /** A unidade da soma é (conversa, semana): ver `umaPorConversa`. */
  readonly conversaId: string
  readonly semana: string
  /** ISO; decide a "primeira". */
  readonly criadoEm: string
  readonly concorda: boolean | null
  readonly porCriterio: Readonly<Partial<Record<CriterioRubrica, boolean | null>>>
  readonly gravidade: boolean
  readonly motivo: MotivoAmostra | null
  readonly falsoNegativoCritica: boolean
}

/**
 * UMA revisão por (conversa, semana) entra na soma: a PRIMEIRA COMPARÁVEL
 * (com nota do juiz) ou, sem nenhuma comparável, a primeira. Por quê:
 *   - a 1ª é a revisão cega (o revisor ainda não tinha visto o juiz);
 *   - dois revisores (ou duas avaliações) na mesma conversa não dobram o peso
 *     dela — o mínimo de 20 é de CONVERSAS distintas, não de linhas.
 * A média entre revisores foi descartada: produz frações de "concorda" e
 * deixaria um revisor tardio (que já viu o juiz) puxar o resultado.
 */
export function umaPorConversa<T extends RevisaoParaSomar>(revs: readonly T[]): T[] {
  const porChave = new Map<string, T>()
  const ordem = (r: T) => [r.concorda === null ? 1 : 0, r.criadoEm] as const
  for (const r of revs) {
    const k = `${r.conversaId}|${r.semana}`
    const atual = porChave.get(k)
    if (!atual) { porChave.set(k, r); continue }
    const [a1, a2] = ordem(atual), [b1, b2] = ordem(r)
    if (b1 < a1 || (b1 === a1 && b2 < a2)) porChave.set(k, r)
  }
  return [...porChave.values()]
}

export interface SomaConcordancia {
  /** Linhas gravadas (todas as revisões, de todos os revisores). */
  readonly revisoes: number
  /** Conversas revisadas (uma por conversa e semana). */
  readonly revisadas: number
  /** Conversas cuja revisão que conta tem nota do juiz — o denominador. */
  readonly comparaveis: number
  /** O mesmo número, com o nome que a P19 usa para o mínimo de 20 (conversas DISTINTAS). */
  readonly conversasComparaveis: number
  readonly concordantes: number
  /** concordantes ÷ comparáveis (0..1); null sem comparáveis. */
  readonly concordancia: number | null
  /** Por critério: fração de comparáveis em que o critério concordou. */
  readonly porCriterio: Readonly<Record<CriterioRubrica, number | null>>
  /** Fração das conversas revisadas com a mesma classe de gravidade. */
  readonly gravidade: number | null
  /** Só as aleatórias — o que estima a concordância real (a amostra é enviesada para casos difíceis). */
  readonly aleatorias: { readonly comparaveis: number; readonly concordancia: number | null }
  readonly falsosNegativosCritica: number
  /** concordancia ≥ META com conversasComparaveis ≥ MIN e nenhum falso negativo CRÍTICO. */
  readonly atingeMeta: boolean
}

const fracao = (a: number, b: number): number | null => (b > 0 ? Math.round((a / b) * 10_000) / 10_000 : null)

/** Soma as revisões (de um número ou de todos), uma por conversa e semana. Pura. */
export function somarConcordancia(todas: readonly RevisaoParaSomar[]): SomaConcordancia {
  const revs = umaPorConversa(todas)
  const comp = revs.filter((r) => r.concorda !== null)
  const concordantes = comp.filter((r) => r.concorda === true).length
  const porCriterio = {} as Record<CriterioRubrica, number | null>
  for (const c of CRITERIOS_RUBRICA) {
    const vs = comp.map((r) => r.porCriterio[c]).filter((v): v is boolean => typeof v === 'boolean')
    porCriterio[c] = fracao(vs.filter(Boolean).length, vs.length)
  }
  const alea = comp.filter((r) => r.motivo === 'aleatoria')
  const concordancia = fracao(concordantes, comp.length)
  // Falso negativo conta em QUALQUER revisão: uma crítica que só um revisor viu ainda é crítica.
  const falsos = new Set(todas.filter((r) => r.falsoNegativoCritica).map((r) => `${r.conversaId}|${r.semana}`)).size
  return {
    revisoes: todas.length,
    revisadas: revs.length,
    comparaveis: comp.length,
    conversasComparaveis: comp.length,
    concordantes,
    concordancia,
    porCriterio,
    gravidade: fracao(revs.filter((r) => r.gravidade).length, revs.length),
    aleatorias: { comparaveis: alea.length, concordancia: fracao(alea.filter((r) => r.concorda === true).length, alea.length) },
    falsosNegativosCritica: falsos,
    atingeMeta: concordancia !== null && concordancia >= META_CONCORDANCIA && comp.length >= MIN_REVISADAS_CONCORDANCIA && falsos === 0,
  }
}

// ── semana ISO (AAAA-Www) ───────────────────────────────────────────────────

export const SEMANA_RE = /^(\d{4})-W(\d{2})$/
const DIA = 86_400_000

function segundaDaSemana1(ano: number): number {
  const jan4 = Date.UTC(ano, 0, 4)
  const dow = (new Date(jan4).getUTCDay() + 6) % 7 // segunda = 0
  return jan4 - dow * DIA
}

/** '2026-W42' → '2026-10-12' (a segunda-feira). null = formato ou semana inexistente. */
export function segundaDaSemana(semana: string): string | null {
  const m = SEMANA_RE.exec(semana)
  if (!m) return null
  const ano = Number(m[1]), n = Number(m[2])
  if (n < 1 || n > 53) return null
  const seg = segundaDaSemana1(ano) + (n - 1) * 7 * DIA
  // Semana 53 só existe em alguns anos: a segunda tem de cair antes da semana 1 do ano seguinte.
  if (seg >= segundaDaSemana1(ano + 1)) return null
  return new Date(seg).toISOString().slice(0, 10)
}

/** '2026-10-17' (data de calendário, já no fuso da loja) → '2026-W42'. */
export function semanaDaData(data: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(data)
  if (!m) return null
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== data) return null
  const dow = (new Date(t).getUTCDay() + 6) % 7
  const quinta = t + (3 - dow) * DIA // a quinta da semana decide o ano ISO
  const ano = new Date(quinta).getUTCFullYear()
  const n = Math.floor((quinta - segundaDaSemana1(ano)) / (7 * DIA)) + 1
  return `${ano}-W${String(n).padStart(2, '0')}`
}

/** Anda `delta` semanas a partir de uma semana válida. */
export function deslocarSemana(semana: string, delta: number): string | null {
  const seg = segundaDaSemana(semana)
  if (!seg) return null
  return semanaDaData(new Date(Date.parse(`${seg}T00:00:00Z`) + delta * 7 * DIA).toISOString().slice(0, 10))
}

// ── contrato HTTP ───────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const nota = z.number().int().min(0).max(5)

/** Corpo de POST /v1/agente/revisao. O revisor e o tenant vêm do token, nunca daqui. */
export const corpoRevisao = z.object({
  avaliacaoId: z.string().regex(UUID_RE),
  notas: z.object(Object.fromEntries(CRITERIOS_RUBRICA.map((c) => [c, nota])) as Record<CriterioRubrica, typeof nota>).strict(),
  gravidade: z.enum(['CRITICA', 'ALTA', 'MEDIA']).nullable(),
  veredito: z.enum(VEREDITOS_REVISAO),
  decisao: z.enum(DECISOES_REVISAO).default('nenhuma'),
  responsavel: z.string().trim().max(MAX_RESPONSAVEL).nullable().optional().transform((v) => (v ? v : null)),
  prazo: z.string().refine((v) => semanaDaData(v) !== null, 'data inválida (AAAA-MM-DD)').nullable().optional().transform((v) => v ?? null),
  observacao: z.string().trim().max(MAX_OBSERVACAO).nullable().optional().transform((v) => (v ? v : null)),
}).strict().superRefine((v, ctx) => {
  if (v.decisao === 'nenhuma') return
  if (!v.responsavel) ctx.addIssue({ code: 'custom', path: ['responsavel'], message: 'decisão com ação precisa de responsável' })
  if (!v.prazo) ctx.addIssue({ code: 'custom', path: ['prazo'], message: 'decisão com ação precisa de prazo' })
})
export type CorpoRevisao = z.input<typeof corpoRevisao>
/** O corpo depois de validado (vazios viram null, decisão padrão 'nenhuma'). */
export type RevisaoValidada = z.output<typeof corpoRevisao>

/** Uma revisão (a do revisor que pede, ou de outro). */
export interface RevisaoDto {
  readonly id: string
  readonly avaliacaoId: string
  readonly revisorId: string
  readonly revisorNome: string
  readonly semana: string
  readonly motivo: MotivoAmostra | null
  readonly notas: NotasHumanas
  readonly gravidade: GravidadeQualidade | null
  readonly veredito: VereditoRevisao
  readonly decisao: DecisaoRevisao
  readonly responsavel: string | null
  readonly prazo: string | null
  readonly observacao: string | null
  readonly notasLlm: NotasDoJuiz | null
  readonly gravidadeSistema: GravidadeQualidade | null
  readonly porCriterio: Readonly<Record<CriterioRubrica, boolean | null>>
  readonly concordaGravidade: boolean
  readonly concorda: boolean | null
  readonly falsoNegativoCritica: boolean
  readonly atualizadoEm: string
}

/** Um item de GET /v1/agente/revisao/amostra. */
/**
 * ⚠️ CEGO até a 1ª revisão de quem pede (`cego: true`): o servidor omite tudo
 *    o que diz o que o SISTEMA achou — motivo da amostra, gravidade, nota e
 *    notas do juiz. Revisar vendo a resposta infla a concordância.
 */
export interface ItemAmostraRevisaoDto {
  /** 1..20, a ordem da P12. */
  readonly ordem: number
  /** null enquanto cego. */
  readonly motivo: MotivoAmostra | null
  readonly conversaId: string
  readonly canalId: string
  /** A avaliação que se revisa: a do juiz com a menor nota da semana; sem juiz, a de regras mais grave. */
  readonly avaliacaoId: string
  readonly origem: OrigemAvaliacao
  /** Quem pede ainda não revisou: os campos do sistema vêm null. */
  readonly cego: boolean
  /** Há nota do juiz na avaliação (sem ela, a revisão não entra na concordância). Não revela a nota. */
  readonly comJuiz: boolean
  /** null enquanto cego. */
  readonly piorGravidade: GravidadeQualidade | null
  /** null enquanto cego. */
  readonly menorNota: number | null
  /** Notas do juiz da avaliação revisada; null enquanto cego ou sem juiz. */
  readonly notasJuiz: NotasDoJuiz | null
  /** A revisão DE QUEM PEDE (null = ainda não revisou). */
  readonly revisao: RevisaoDto | null
  /** Quantos revisores já revisaram esta conversa na semana. */
  readonly revisoes: number
}

export interface AmostraRevisaoDto {
  readonly semana: string
  /** Segunda-feira da semana (AAAA-MM-DD, fuso da loja). */
  readonly inicio: string
  readonly canalId: string
  readonly itens: readonly ItemAmostraRevisaoDto[]
  /** A amostra tem no máximo 20 por número — não há próxima página. */
  readonly proximoCursor: null
}

export interface FalaRevisao {
  /** cliente · agente (o que o agente enviou) · sugestao (o que decidiu sem enviar) · humano (vendedor, contexto). */
  readonly autor: 'cliente' | 'agente' | 'sugestao' | 'humano'
  /** Mascarado (telefone, CPF, CNPJ, e-mail). */
  readonly texto: string
}

/**
 * Uma violação como o revisor a vê. Enquanto CEGO, só o trecho: `regra`,
 * `detalhe` e `gravidade` vêm null (já diriam o que o sistema achou).
 */
export interface ViolacaoRevisao {
  readonly trecho: string
  readonly regra: ViolacaoQualidade['regra'] | null
  readonly detalhe: string | null
  readonly gravidade: GravidadeQualidade | null
}

/** GET /v1/agente/revisao/avaliacoes/:id — o que a tela mostra ao lado do formulário. */
export interface DetalheRevisaoDto {
  readonly avaliacaoId: string
  readonly conversaId: string
  readonly canalId: string
  readonly semana: string
  readonly origem: OrigemAvaliacao
  readonly transcricao: readonly FalaRevisao[]
  /** A transcrição foi cortada no início (conversa longa). */
  readonly cortada: boolean
  /** Quem pede ainda não revisou esta avaliação: notas, justificativas, gravidade do sistema e gravidade das violações vêm omitidas. */
  readonly cego: boolean
  readonly comJuiz: boolean
  readonly notasJuiz: NotasDoJuiz | null
  readonly justificativas: Readonly<Partial<Record<CriterioRubrica, string>>> | null
  /** Pior gravidade das regras na MESMA sessão da transcrição; null enquanto cego. */
  readonly gravidadeSistema: GravidadeQualidade | null
  /** O que escapou das regras na sessão (mascarado); `gravidade` null enquanto cego. */
  readonly violacoes: readonly ViolacaoRevisao[]
  readonly revisao: RevisaoDto | null
}

export interface ConcordanciaNumeroDto extends SomaConcordancia {
  readonly canalId: string
  readonly nome: string
}

/** GET /v1/agente/revisao/concordancia — o contrato que a P19 consome. */
export interface ConcordanciaDto extends SomaConcordancia {
  readonly semana: string
  readonly canalId: string | null
  readonly meta: number
  readonly minimoRevisadas: number
  readonly porNumero: readonly ConcordanciaNumeroDto[]
}
