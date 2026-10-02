import {
  FAIXAS_REGRAS_AGENTE, ROTULO_HANDOFF, validarRegrasAgente,
  type ModoAgente, type ObjetivoAgente, type RegrasDoAgente, type SlotQualificacao, type Tom as TomPersona,
} from '@geracrm/shared'

/**
 * Regras PURAS da tela do agente vendedor — sem DOM, sem Angular, testáveis.
 *
 * ⚠️ Tudo que vira texto, cor de badge ou erro de campo mora aqui, e não no
 * template: é o que o `agente.regras.spec.ts` cobre. Regra de NEGÓCIO (faixas,
 * alçada, validação das regras de entrada) continua em `@geracrm/shared` — a
 * tela só apresenta.
 */

export type Tom = 'neutro' | 'sucesso' | 'atencao' | 'erro' | 'info'

/** Os desfechos de um turno (ADR-023) — espelha `DesfechoTurno` da API. */
export const DESFECHOS = ['respondeu', 'sugeriu', 'handoff', 'silencio', 'falha', 'superada'] as const
export type Desfecho = (typeof DESFECHOS)[number]

const ROTULO_DESFECHO: Record<Desfecho, string> = {
  respondeu: 'Respondeu',
  sugeriu: 'Sugeriu',
  handoff: 'Entregou ao humano',
  silencio: 'Ficou em silêncio',
  falha: 'Falhou',
  superada: 'Superada',
}
const TOM_DESFECHO: Record<Desfecho, Tom> = {
  respondeu: 'sucesso',
  sugeriu: 'info',
  handoff: 'atencao',
  silencio: 'neutro',
  falha: 'erro',
  superada: 'neutro',
}

/** Rótulo e tom do badge de desfecho. Valor desconhecido (API mais nova) sai cru, neutro. */
export function badgeDesfecho(d: string): { rotulo: string; tom: Tom } {
  const conhecido = (DESFECHOS as readonly string[]).includes(d)
  return conhecido
    ? { rotulo: ROTULO_DESFECHO[d as Desfecho], tom: TOM_DESFECHO[d as Desfecho] }
    : { rotulo: d, tom: 'neutro' }
}

/** Badge do modo — curto, para leitura periférica; `simulacao` vem do playground. */
export function badgeModo(m: string): { rotulo: string; tom: Tom } {
  switch (m) {
    case 'desligado': return { rotulo: 'Desligado', tom: 'neutro' }
    case 'sombra': return { rotulo: 'Sombra', tom: 'neutro' }
    case 'assistido': return { rotulo: 'Assistido', tom: 'info' }
    case 'autonomo': return { rotulo: 'Autônomo', tom: 'sucesso' }
    case 'simulacao': return { rotulo: 'Simulação', tom: 'neutro' }
    default: return { rotulo: m, tom: 'neutro' }
  }
}

/** Uma linha por modo — o que muda para o cliente e para a equipe. */
export const EXPLICACAO_MODO: Readonly<Record<ModoAgente, string>> = {
  desligado: 'Não lê nem responde nada neste número.',
  sombra: 'Lê as conversas e registra o que responderia, sem enviar. Para avaliar antes de ligar.',
  assistido: 'Prepara a resposta e um vendedor aprova antes de enviar.',
  autonomo: 'Responde sozinho ao cliente, dentro da alçada e das regras abaixo.',
}

// ─── Dinheiro: a tela fala em reais, a API em centavos inteiros ─────────────

/**
 * "1.234,56", "1234,56", "1234.56", "R$ 1.234,56" e "1234" viram centavos.
 * ⚠️ Retorna `null` para texto inválido — nunca `NaN` nem 0: zero é um valor
 * legítimo de alçada ("nada sozinho") e não pode nascer de digitação errada.
 */
export function reaisParaCentavos(texto: string): number | null {
  const s = texto.replace(/R\$/i, '').replace(/\s/g, '')
  if (!s) return null
  const comMilhar = /^\d{1,3}(\.\d{3})+(,\d{1,2})?$/
  const simples = /^\d+([.,]\d{1,2})?$/
  if (!comMilhar.test(s) && !simples.test(s)) return null
  let normalizado: string
  if (/,\d{1,2}$/.test(s)) normalizado = s.replace(/\./g, '').replace(',', '.')
  else if (comMilhar.test(s)) normalizado = s.replace(/\./g, '')
  else normalizado = s
  const n = Number(normalizado)
  return Number.isFinite(n) ? Math.round(n * 100) : null
}

/** Centavos → "1.234,56" (sem símbolo), para preencher o campo. */
export function centavosParaTexto(centavos: number): string {
  const abs = Math.abs(Math.round(centavos))
  const inteiro = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  const dec = String(abs % 100).padStart(2, '0')
  return `${centavos < 0 ? '-' : ''}${inteiro},${dec}`
}

/** Centavos → "R$ 1.234,56". Sem Intl: o resultado não pode variar por ambiente. */
export function formatarReais(centavos: number): string {
  return `R$ ${centavosParaTexto(centavos)}`
}

// ─── Erros: do servidor e da tela, SEMPRE por campo ──────────────────────────

export interface ErroApi {
  readonly erro: string
  readonly mensagem?: string
  readonly campos?: readonly string[]
}

export interface ErrosDeFormulario {
  /** Chave = caminho do campo como a API nomeia (`persona.nome`, `maxTurnos`). */
  readonly campos: Readonly<Record<string, string>>
  /** Falha que não pertence a campo nenhum (chave do servidor, 404…). */
  readonly geral: string | null
}

/**
 * Mapeia o 422 da API para o campo certo.
 *
 * ⚠️ `agente.sem_politicas` não traz `campos`, mas É um erro de campo — a
 * frase precisa aparecer embaixo das políticas, não num banner genérico.
 */
export function errosDoServidor(e: ErroApi): ErrosDeFormulario {
  const msg = e.mensagem ?? 'Não foi possível salvar.'
  if (e.erro === 'agente.sem_politicas') return { campos: { politicas: msg }, geral: null }
  if (e.campos && e.campos.length > 0) {
    const campos: Record<string, string> = {}
    for (const c of e.campos) campos[c] = msg
    return { campos, geral: null }
  }
  return { campos: {}, geral: msg }
}

/** O que a tela edita — texto cru, antes de virar o corpo do PUT. */
export interface FormularioAgente {
  readonly modo: ModoAgente
  readonly politicas: string
  readonly persona: {
    readonly nome: string; readonly loja: string; readonly tom: string
    readonly usaEmojis: boolean; readonly saudacao: string; readonly identificaComoRobo: boolean
  }
  readonly objetivo: string
  readonly qualificacao: readonly string[]
  readonly alcada: { readonly valorMaxTexto: string; readonly descontoMaxPct: number; readonly efetivaSozinho: boolean }
  readonly regras: RegrasDoAgente
  readonly modelo: string
  readonly limiarConfianca: number
  readonly maxRodadas: number
  readonly prazoTurnoMs: number
  readonly orcamentoDiaTexto: string
}

export const FAIXAS_AVANCADO = {
  limiarConfianca: { min: 0, max: 1 },
  maxRodadas: { min: 1, max: 12 },
  prazoTurnoMs: { min: 3000, max: 60000 },
  descontoMaxPct: { min: 0, max: 100 },
} as const

/**
 * Validação de borda da tela — os MESMOS limites que a API aplica, para o erro
 * aparecer antes do clique e no campo certo. Retorna `{}` quando está tudo bem.
 */
export function validarFormulario(f: FormularioAgente): Readonly<Record<string, string>> {
  const erros: Record<string, string> = {}
  const nome = f.persona.nome.trim()
  if (!nome) erros['persona.nome'] = 'Dê um nome ao agente — é como ele se apresenta.'
  else if (nome.length > 40) erros['persona.nome'] = 'Até 40 caracteres.'
  if (f.persona.loja.trim().length > 80) erros['persona.loja'] = 'Até 80 caracteres.'
  if (f.persona.saudacao.trim().length > 300) erros['persona.saudacao'] = 'Até 300 caracteres.'
  if (f.modo === 'autonomo' && !f.politicas.trim()) {
    erros['politicas'] = 'Escreva as políticas da loja antes de deixar o agente autônomo — sem elas ele responde "não sei" a tudo.'
  }
  if (reaisParaCentavos(f.alcada.valorMaxTexto) === null) {
    erros['alcada.valorMaxAutonomoCentavos'] = 'Informe um valor em reais, por exemplo 1.500,00.'
  }
  if (!dentro(f.alcada.descontoMaxPct, FAIXAS_AVANCADO.descontoMaxPct)) {
    erros['alcada.descontoMaxPct'] = 'Desconto entre 0 e 100%.'
  }
  if (!dentro(f.limiarConfianca, FAIXAS_AVANCADO.limiarConfianca)) erros['limiarConfianca'] = 'Entre 0 e 1.'
  if (!Number.isInteger(f.maxRodadas) || !dentro(f.maxRodadas, FAIXAS_AVANCADO.maxRodadas)) {
    erros['maxRodadas'] = `Número inteiro entre ${FAIXAS_AVANCADO.maxRodadas.min} e ${FAIXAS_AVANCADO.maxRodadas.max}.`
  }
  if (!Number.isInteger(f.prazoTurnoMs) || !dentro(f.prazoTurnoMs, FAIXAS_AVANCADO.prazoTurnoMs)) {
    erros['prazoTurnoMs'] = `Entre ${FAIXAS_AVANCADO.prazoTurnoMs.min} e ${FAIXAS_AVANCADO.prazoTurnoMs.max} ms.`
  }
  if (f.orcamentoDiaTexto.trim() && reaisParaCentavos(f.orcamentoDiaTexto) === null) {
    erros['orcamentoDiaCentavos'] = 'Informe um valor em reais ou deixe em branco para não limitar.'
  }
  if (f.modelo.trim().length > 80) erros['modelo'] = 'Até 80 caracteres.'
  const r = validarRegrasAgente(f.regras)
  if (!r.ok) for (const e of r.erros) erros[e.campo] = e.mensagem
  return erros
}

function dentro(n: number, faixa: { readonly min: number; readonly max: number }): boolean {
  return Number.isFinite(n) && n >= faixa.min && n <= faixa.max
}

/** O corpo do PUT — centavos inteiros, regras achatadas, textos aparados. */
export function corpoParaSalvar(f: FormularioAgente): Record<string, unknown> {
  return {
    modo: f.modo,
    politicas: f.politicas.trim(),
    persona: {
      nome: f.persona.nome.trim(), loja: f.persona.loja.trim(), tom: f.persona.tom,
      usaEmojis: f.persona.usaEmojis, saudacao: f.persona.saudacao.trim(),
      identificaComoRobo: f.persona.identificaComoRobo,
    },
    objetivo: f.objetivo,
    qualificacao: [...f.qualificacao],
    alcada: {
      valorMaxAutonomoCentavos: reaisParaCentavos(f.alcada.valorMaxTexto) ?? 0,
      descontoMaxPct: f.alcada.descontoMaxPct,
      efetivaSozinho: f.alcada.efetivaSozinho,
    },
    modelo: f.modelo.trim() || null,
    limiarConfianca: f.limiarConfianca,
    maxRodadas: f.maxRodadas,
    prazoTurnoMs: f.prazoTurnoMs,
    orcamentoDiaCentavos: f.orcamentoDiaTexto.trim() ? reaisParaCentavos(f.orcamentoDiaTexto) : null,
    ...f.regras,
  }
}

/** As regras de entrada divergem do padrão? Decide se "voltar ao padrão" aparece. */
export function mudouDoPadrao(regras: RegrasDoAgente, padrao: RegrasDoAgente): boolean {
  return (Object.keys(padrao) as (keyof RegrasDoAgente)[]).some((k) => regras[k] !== padrao[k])
}

export { FAIXAS_REGRAS_AGENTE }

// ─── Sessões ─────────────────────────────────────────────────────────────────

export function rotuloEstadoSessao(e: string): string {
  switch (e) {
    case 'ativa': return 'Em conversa'
    case 'entregue': return 'Entregue ao humano'
    case 'encerrada': return 'Encerrada'
    default: return e
  }
}

export function tomEstadoSessao(e: string): Tom {
  return e === 'entregue' ? 'atencao' : e === 'ativa' ? 'info' : 'neutro'
}

/** O que foi colhido, em uma linha legível — ou `null` quando nada veio. */
export function resumoExtraido(extraido: Readonly<Record<string, unknown>>): string | null {
  const partes = Object.entries(extraido)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${String(v)}`)
  return partes.length > 0 ? `Colheu — ${partes.join(' · ')}` : null
}

// ─── Bastidores ──────────────────────────────────────────────────────────────

export interface Uso { readonly entrada?: number; readonly saida?: number; readonly cacheLeitura?: number; readonly cacheEscrita?: number }

/** "1.2k entrada · 340 saída · 900 cache" — tokens em uma linha. */
export function resumoDeUso(uso: Uso | null | undefined): string {
  if (!uso) return '—'
  const n = (v: number | undefined) => v === undefined ? '0' : v >= 1000 ? `${(v / 1000).toFixed(1).replace('.', ',')}k` : String(v)
  const cache = (uso.cacheLeitura ?? 0) + (uso.cacheEscrita ?? 0)
  const partes = [`${n(uso.entrada)} entrada`, `${n(uso.saida)} saída`]
  if (cache > 0) partes.push(`${n(cache)} cache`)
  return partes.join(' · ')
}

/** Confiança 0..1 → "72%"; `null` → "—". */
export function formatarConfianca(c: number | null | undefined): string {
  return c === null || c === undefined ? '—' : `${Math.round(c * 100)}%`
}

/** JSON legível para o painel de bastidores; nunca lança. */
export function jsonLegivel(v: unknown): string {
  try { return JSON.stringify(v, null, 2) ?? 'null' } catch { return String(v) }
}

// ─── Rótulos de domínio para a tela ──────────────────────────────────────────

/** Motivo de handoff em português; desconhecido sai cru (API mais nova). */
export function rotuloHandoff(motivo: string | null | undefined): string | null {
  if (!motivo) return null
  return (ROTULO_HANDOFF as Readonly<Record<string, string>>)[motivo] ?? motivo
}

export const ROTULO_SLOT: Readonly<Record<SlotQualificacao, string>> = {
  tipoCompra: 'Tipo de compra (revenda ou uso próprio)',
  cidade: 'Cidade',
  volume: 'Volume ou quantidade',
  prazo: 'Prazo de compra',
  orcamento: 'Orçamento',
  necessidade: 'Necessidade',
  cnpj: 'CNPJ',
}

export const ROTULO_TOM: Readonly<Record<TomPersona, string>> = {
  informal: 'Informal — "oi, tudo bem?"',
  neutro: 'Neutro — cordial e direto',
  formal: 'Formal — "prezado cliente"',
}

export const ROTULO_OBJETIVO: Readonly<Record<ObjetivoAgente, string>> = {
  vender: 'Vender — recomenda, monta e propõe o pedido',
  qualificar: 'Qualificar — colhe o que falta e entrega ao vendedor',
}

export const ROTULO_FASE: Readonly<Record<string, string>> = {
  descoberta: 'Descoberta',
  recomendacao: 'Recomendação',
  proposta: 'Proposta',
  fechamento: 'Fechamento',
  handoff: 'Handoff',
  encerrada: 'Encerrada',
}
