import { z } from 'zod'

/**
 * OBJEÇÕES DO PLAYBOOK (plano de paridade AM, raia G2; #93, #104).
 *
 * O catálogo de objeções do negócio — "achei caro", "vou pensar", "já compro de
 * outro" — com código estável (OBJ-01…), gatilhos (palavras do cliente que a
 * denunciam) e uma RESPOSTA DE REFERÊNCIA. Mora no playbook versionado
 * (rascunho → publicar → histórico), entra no bloco estável do prompt e é o
 * vocabulário da ferramenta `registrar_objecao`.
 *
 * ⚠️ A ferramenta SÓ registra (código + revertida). Quem decide a entrega ao
 *    humano na 3ª objeção NÃO revertida seguida é a etapa do pipeline
 *    `objecoes-seguidas` — regra que protege fica no código (ADR-029).
 * ⚠️ A resposta de referência não carrega número de negócio: preço, prazo e
 *    percentual vêm de ferramenta no turno (a validação está em
 *    `errosDaRespostaObjecao`, no playbook).
 *
 * TypeScript puro: consumido pela API (ferramenta, etapa, qualidade, rotas) e pelo console.
 * ⚠️ Não importa `agente-playbook` (o playbook importa daqui).
 */

// ── limites e formato ───────────────────────────────────────────────────────

export const LIMITES_OBJECOES = {
  objecoesMax: 60,
  objecao: 200,
  objecaoMin: 3,
  gatilhosMax: 10,
  gatilho: 60,
  gatilhoMin: 2,
  respostaObjecao: 1200,
  respostaObjecaoMin: 10,
  observacaoObjecao: 200,
} as const

/** "OBJ-01" … "OBJ-99". */
export const CODIGO_OBJECAO_RE = /^OBJ-\d{2}$/

export const itemObjecao = z.object({
  codigo: z.string().regex(CODIGO_OBJECAO_RE, 'Código no formato OBJ-01.'),
  ativo: z.boolean(),
  objecao: z.string().trim()
    .min(LIMITES_OBJECOES.objecaoMin, `Descreva a objeção em ao menos ${LIMITES_OBJECOES.objecaoMin} caracteres.`)
    .max(LIMITES_OBJECOES.objecao, `No máximo ${LIMITES_OBJECOES.objecao} caracteres.`),
  gatilhos: z.array(z.string().trim()
    .min(LIMITES_OBJECOES.gatilhoMin, `Gatilho com ao menos ${LIMITES_OBJECOES.gatilhoMin} caracteres.`)
    .max(LIMITES_OBJECOES.gatilho, `Gatilho com no máximo ${LIMITES_OBJECOES.gatilho} caracteres.`))
    .max(LIMITES_OBJECOES.gatilhosMax, `No máximo ${LIMITES_OBJECOES.gatilhosMax} gatilhos por objeção.`),
  resposta: z.string().trim()
    .min(LIMITES_OBJECOES.respostaObjecaoMin, `Escreva a resposta de referência em ao menos ${LIMITES_OBJECOES.respostaObjecaoMin} caracteres.`)
    .max(LIMITES_OBJECOES.respostaObjecao, `No máximo ${LIMITES_OBJECOES.respostaObjecao} caracteres.`),
}).strict()
export type ObjecaoPlaybook = z.output<typeof itemObjecao>

/** O próximo código livre (maior + 1). null quando já chegou a OBJ-99. */
export function proximoCodigoObjecao(existentes: ReadonlyArray<{ readonly codigo: string }>): string | null {
  const maior = existentes.reduce((m, o) => (CODIGO_OBJECAO_RE.test(o.codigo) ? Math.max(m, Number(o.codigo.slice(4))) : m), 0)
  return maior >= 99 ? null : `OBJ-${String(maior + 1).padStart(2, '0')}`
}

// ── casamento de gatilhos ───────────────────────────────────────────────────

/** Sem acento, minúsculas, pontuação vira espaço, espaços colapsados. */
export function normalizarGatilho(t: string): string {
  return t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim()
}

/** O gatilho aparece no texto como palavra(s) inteira(s)? ("caro" não casa "carona"). */
export function gatilhoCasa(texto: string, gatilho: string): boolean {
  const g = normalizarGatilho(gatilho)
  if (!g) return false
  return ` ${normalizarGatilho(texto)} `.includes(` ${g} `)
}

/** Objeções ATIVAS com algum gatilho presente no texto do cliente, na ordem do playbook. */
export function objecoesQueCasam(texto: string, objecoes: readonly ObjecaoPlaybook[]): ObjecaoPlaybook[] {
  if (!texto.trim()) return []
  return objecoes.filter((o) => o.ativo && o.gatilhos.some((g) => gatilhoCasa(texto, g)))
}

// ── "segue a referência" (heurística da regra de qualidade) ─────────────────

const PALAVRAS_VAZIAS = new Set([
  'para', 'pelo', 'pela', 'pelos', 'pelas', 'como', 'mais', 'mas', 'que', 'com', 'sem', 'uma', 'umas', 'uns', 'dos', 'das',
  'nos', 'nas', 'num', 'numa', 'voce', 'voces', 'seu', 'sua', 'seus', 'suas', 'esse', 'essa', 'isso', 'este', 'esta', 'isto',
  'aqui', 'entao', 'tambem', 'muito', 'muita', 'quando', 'onde', 'porque', 'pois', 'ainda', 'sobre', 'entre', 'depois',
  'antes', 'cada', 'todo', 'toda', 'todos', 'todas', 'gente', 'nosso', 'nossa', 'nossos', 'nossas', 'pode', 'posso',
  'tenho', 'temos', 'ter', 'ser', 'esta', 'estou', 'sao', 'foi', 'vai', 'vou', 'bem', 'sim', 'nao', 'ola', 'oi',
])

function palavrasDeConteudo(t: string): Set<string> {
  return new Set(normalizarGatilho(t).split(' ').filter((p) => p.length >= 4 && !PALAVRAS_VAZIAS.has(p)))
}

/** Fração mínima das palavras de conteúdo da referência que precisa aparecer na resposta. */
export const LIMIAR_SEGUE_REFERENCIA = 0.4

/**
 * A resposta do agente SEGUE a referência? Heurística simples e barata: ao
 * menos 40% das palavras de conteúdo da referência (≥ 4 letras, sem palavras
 * vazias) aparecem nas mensagens. Referência sem palavra de conteúdo não é
 * seguível (false). ⚠️ É só a metade "branda" da regra de qualidade; a metade
 * determinística é "gatilho casou e nenhuma `registrar_objecao` no turno".
 */
export function segueReferencia(mensagens: readonly string[], referencia: string): boolean {
  const ref = palavrasDeConteudo(referencia)
  if (ref.size === 0) return false
  const resp = palavrasDeConteudo(mensagens.join(' '))
  let comuns = 0
  for (const p of ref) if (resp.has(p)) comuns++
  return comuns / ref.size >= LIMIAR_SEGUE_REFERENCIA
}

// ── estado da sessão (`agente_sessao.estado_agente.objecoes`) ───────────────

/** Uma objeção registrada na sessão. Sem texto do cliente: o estado aparece na auditoria. */
export interface ObjecaoNoEstado {
  readonly codigo: string
  readonly revertida: boolean
  /** Turno da sessão em que foi registrada (1 = primeiro). */
  readonly turno: number
}

/** Teto da lista no estado (as mais recentes ficam): a regra só olha o rabo. */
export const MAX_OBJECOES_NO_ESTADO = 30
/** Na 3ª objeção NÃO revertida seguida, uma pessoa assume (comportamento do AM). */
export const OBJECOES_SEGUIDAS_PARA_HANDOFF = 3

/** Leitura TOLERANTE: item fora do formato é descartado. */
export function lerEstadoObjecoes(v: unknown): ObjecaoNoEstado[] {
  if (!Array.isArray(v)) return []
  return v.flatMap((x): ObjecaoNoEstado[] => {
    if (!x || typeof x !== 'object') return []
    const o = x as Record<string, unknown>
    if (typeof o['codigo'] !== 'string' || typeof o['revertida'] !== 'boolean') return []
    const turno = typeof o['turno'] === 'number' && Number.isInteger(o['turno']) && o['turno'] > 0 ? o['turno'] : 1
    return [{ codigo: o['codigo'], revertida: o['revertida'], turno }]
  })
}

/** Quantas objeções NÃO revertidas há seguidas no fim da lista (uma revertida zera). */
export function naoRevertidasSeguidas(lista: readonly ObjecaoNoEstado[]): number {
  let n = 0
  for (let i = lista.length - 1; i >= 0 && !lista[i]!.revertida; i--) n++
  return n
}

// ── relatório ───────────────────────────────────────────────────────────────

export const JANELA_RESUMO_OBJECOES_PADRAO = 30
export const JANELA_RESUMO_OBJECOES_MAX = 90

/** Uma linha de `GET /v1/agente/objecoes/resumo`. */
export interface ResumoObjecaoDto {
  readonly codigo: string
  /** A objeção como estava no playbook na última vez em que foi registrada. */
  readonly objecao: string
  readonly vezes: number
  readonly revertidas: number
  /** 0–100, inteiro; null sem registro. */
  readonly percentualRevertida: number | null
}

export interface ResumoObjecoesDto {
  readonly dias: number
  readonly canalId: string | null
  readonly itens: readonly ResumoObjecaoDto[]
}

/** % revertida arredondada (0–100). null quando não houve registro. */
export function percentualRevertida(vezes: number, revertidas: number): number | null {
  if (!Number.isFinite(vezes) || vezes <= 0) return null
  return Math.round((Math.min(Math.max(revertidas, 0), vezes) / vezes) * 100)
}
