/**
 * QUALIDADE EM PRODUÇÃO (ADR-031, raia P12) — o lado puro, TypeScript puro:
 * consumido pela API (etapa do pipeline, worker do juiz, rotas), pelo console
 * (tela de qualidade) e pelas raias seguintes (P15 evals, P16 revisão humana,
 * P19 painel de fase).
 *
 *   1. REGRAS em 100% das respostas do agente (e das sugestões): o que ESCAPOU
 *      das etapas anteriores do pipeline — palavra proibida, promessa de prazo,
 *      número sem fonte, pergunta repetida, várias perguntas, mensagem longa.
 *      Custo zero. CRÍTICA antes do envio pausa a conversa.
 *   2. JUIZ com RUBRICA de 5 critérios (0–5 + justificativa ≤ 280), fora do
 *      caminho da resposta, só numa AMOSTRA ESTÁVEL por hash da conversa.
 *   3. A ORDEM da amostra semanal (CSV e revisão humana): CRÍTICA → ALTA ou
 *      nota ≤ 3 → aleatórias (estáveis por semente).
 *
 * ⚠️ Nenhum trecho sai daqui sem `mascararTextoQualidade` (telefone, CPF, CNPJ,
 *    e-mail): as violações vão para o banco, para a tela e para o CSV.
 */
import { z } from 'zod'
import type { GravidadeGuardrail, ModoAgente } from './agente-vendedor.js'
import { filtrarSaida, PROMESSA_PRAZO_RE, termoNegado } from './agente-filtro.js'
import { ehPerguntaDePedido, mesmaPergunta, perguntasDe } from './agente-perguntas.js'
import { numerosSemFonte, type FontesDeNumeros } from './agente-numeros.js'

// ── vocabulário ─────────────────────────────────────────────────────────────

export const REGRAS_QUALIDADE = [
  'palavra_proibida', 'promessa_prazo', 'numero_sem_fonte', 'pergunta_repetida', 'multiplas_perguntas', 'mensagem_longa',
] as const
export type RegraQualidade = (typeof REGRAS_QUALIDADE)[number]

export const ROTULO_REGRA_QUALIDADE: Readonly<Record<RegraQualidade, string>> = {
  palavra_proibida: 'Frase proibida',
  promessa_prazo: 'Promessa de prazo',
  numero_sem_fonte: 'Número sem fonte',
  pergunta_repetida: 'Pergunta repetida',
  multiplas_perguntas: 'Várias perguntas',
  mensagem_longa: 'Mensagem longa',
}

/** Gravidades de uma violação (INFO não é violação). */
export type GravidadeQualidade = Exclude<GravidadeGuardrail, 'INFO'>
export const GRAVIDADES_QUALIDADE: readonly GravidadeQualidade[] = ['CRITICA', 'ALTA', 'MEDIA']
const PESO: Readonly<Record<GravidadeQualidade, number>> = { CRITICA: 3, ALTA: 2, MEDIA: 1 }

/** De onde veio a resposta avaliada: o agente falou com o cliente, ou só sugeriu (sombra/assistido/copiloto). */
export const ORIGENS_AVALIACAO = ['agente', 'sugestao'] as const
export type OrigemAvaliacao = (typeof ORIGENS_AVALIACAO)[number]

export const TIPOS_AVALIACAO = ['regras', 'juiz'] as const
export type TipoAvaliacao = (typeof TIPOS_AVALIACAO)[number]

/** O que disparou a avaliação: o turno (regras), fim de sessão, a cada 10 turnos ou pedido manual. */
export const GATILHOS_AVALIACAO = ['turno', 'fim_sessao', 'turnos', 'manual'] as const
export type GatilhoAvaliacao = (typeof GATILHOS_AVALIACAO)[number]

/**
 * O que a qualidade fez: `pausa_humano` (autônomo/simulação: não enviou e
 * transferiu), `nao_envie` (sugestão marcada), `registrado` (só anotou).
 */
export const ACOES_AVALIACAO = ['pausa_humano', 'nao_envie', 'registrado'] as const
export type AcaoAvaliacao = (typeof ACOES_AVALIACAO)[number]

/** Etapa do pipeline que grava as marcas das regras (`agente_decisao.guardrails[].etapa`). */
export const ETAPA_REGRAS_QUALIDADE = 'regras-qualidade'
/** Código da marca que pede "não envie assim" numa sugestão com violação CRÍTICA. */
export const CODIGO_NAO_ENVIE = 'nao_envie'
/** Alerta (tabela `alerta`) aberto quando uma violação CRÍTICA aparece antes do envio. */
export const ALERTA_VIOLACAO_CRITICA = 'agente_violacao_critica'
/** Alerta aberto quando o juiz parou no teto mensal de custo. */
export const ALERTA_TETO_JUIZ = 'agente_qualidade_teto'
/** O juiz roda a cada N turnos da sessão (e no fim dela). */
export const TURNOS_ENTRE_AVALIACOES = 10
export const MAX_JUSTIFICATIVA = 280
export const MAX_TRECHO_QUALIDADE = 160
/** Limite de caracteres quando o número não configurou o seu. */
export const MAX_CARACTERES_PADRAO_QUALIDADE = 600

export interface ViolacaoQualidade {
  readonly regra: RegraQualidade
  readonly gravidade: GravidadeQualidade
  /** Trecho mascarado, ≤ 160. */
  readonly trecho: string
  /** O que disparou (id da frase proibida, "3 perguntas", "780 caracteres"…). */
  readonly detalhe?: string | undefined
}

// ── máscara ─────────────────────────────────────────────────────────────────

/**
 * Tira dado pessoal de um texto antes de gravar, mostrar ou exportar: e-mail,
 * CPF, CNPJ e telefone (com ou sem DDI/DDD, com ou sem separadores).
 * ⚠️ Valor em reais ("R$ 1.234,56") e quantidade ficam — são o assunto da
 *    avaliação; só sequência longa de dígitos com cara de documento/telefone sai.
 */
export function mascararTextoQualidade(texto: string): string {
  return texto
    .replace(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu, '[e-mail]')
    .replace(/(?<!\d)\d{2}[.\s]?\d{3}[.\s]?\d{3}[/\s]?\d{4}[-\s]?\d{2}(?!\d)/g, '[cnpj]')
    .replace(/(?<!\d)\d{3}[.\s]?\d{3}[.\s]?\d{3}[-\s]?\d{2}(?!\d)/g, '[cpf]')
    // Telefone com ou sem DDI (+55/55), DDD com ou sem parênteses, 9 solto e separadores:
    // "5585999991277", "+55 85 99999-1277", "558599991277", "85 9 9999-1277", "(85) 99999-1277".
    .replace(/(?<!\d)(?:\+?55[\s.-]?)?\(?\d{2}\)?[\s.-]?(?:9[\s.-]?)?\d{4}[\s.-]?\d{4}(?!\d)/g, '[telefone]')
}

function trechoDe(t: string): string {
  const s = mascararTextoQualidade(t.replace(/\s+/g, ' ').trim())
  return s.length > MAX_TRECHO_QUALIDADE ? `${s.slice(0, MAX_TRECHO_QUALIDADE - 1)}…` : s
}

/** Frases (sem quebrar decimal "1,5" nem milhar "4.000"). */
function frases(texto: string): string[] {
  return (texto.match(/(?:[^.!?\n]|(?<=\d)[.,](?=\d))+[.!?…]*/gu) ?? []).map((f) => f.trim()).filter(Boolean)
}

// ── regras ──────────────────────────────────────────────────────────────────

const B = '(?<![\\p{L}\\p{N}])'
const E = '(?![\\p{L}\\p{N}])'
const re = (src: string): RegExp => new RegExp(src, 'iu')

/**
 * O que o filtro de saída (P2) não cobre e a qualidade vigia no B2B. A lista
 * base do filtro roda de novo sobre o texto final (pega o que escapou); estas
 * são as expressões a mais.
 */
export const PROIBIDAS_QUALIDADE_B2B: ReadonlyArray<{ readonly id: string; readonly re: RegExp; readonly gravidade: GravidadeQualidade; readonly ignoraNegacao?: boolean }> = [
  {
    // Sonegação: venda sem nota, "por fora", meia nota. Nunca é proposta do agente.
    id: 'venda_sem_nota', gravidade: 'CRITICA',
    re: re(`${B}(?:sem\\s+(?:emitir\\s+|emiss[aã]o\\s+de\\s+|a\\s+)?(?:nota(?:\\s+fiscal)?|nf-?e?)|por\\s+fora\\s+da\\s+nota|nota\\s+por\\s+fora|meia\\s+nota)${E}`),
  },
  {
    // Crédito/cadastro aprovado na hora: quem aprova é o financeiro/ERP.
    id: 'credito_na_hora', gravidade: 'CRITICA',
    re: re(`${B}(?:cr[eé]dito|limite|cadastro)\\s+(?:[\\p{L}]+\\s+){0,2}?(?:aprovad[oa]|liberad[oa])\\s+(?:[\\p{L}]+\\s+){0,2}?(?:na\\s+hora|hoje|j[aá]|na\\s+mesma\\s+hora|imediatamente|na\\s+certa)${E}|${B}(?:j[aá]\\s+)?(?:aprovamos|liberamos)\\s+(?:seu\\s+|sua\\s+|o\\s+)?(?:cr[eé]dito|limite|cadastro)\\s+(?:[\\p{L}]+\\s+){0,2}?(?:na\\s+(?:mesma\\s+)?hora|imediatamente|na\\s+certa)${E}|${B}aprova[cç][aã]o\\s+(?:imediata|na\\s+hora|certa|autom[aá]tica)${E}`),
  },
  { id: 'sem_risco', gravidade: 'ALTA', ignoraNegacao: true, re: re(`${B}(?:sem\\s+(?:nenhum\\s+)?risco|risco\\s+zero)${E}`) },
]

/** Prazo de entrega por data, sem número ("chega amanhã", "sai hoje ainda"): o P7 só vê "em N dias". */
const PRAZO_ENTREGA_RE = re(
  `${B}(?:chega|chegam|chegar[aá]|chegaria|entrega|entregamos|entregaremos|entregue|despachamos|despacha|enviamos|sai|saem|vai\\s+chegar|vai\\s+sair)${E}`
  + `[^.!?\\n]{0,30}?${B}(?:hoje|amanh[aã]|segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo|ainda\\s+hoje|em\\s+breve|rapidinho|logo\\s+logo|at[eé]\\s+o\\s+fi(?:m|nal)\\s+d[ao]\\s+(?:dia|semana))${E}`,
)
const DIA_SRC = 'segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo'
const FAIXA_DE_DIAS_RE = new RegExp(
  `${B}(?:de|da|do)\\s+(?:${DIA_SRC})(?:-feira)?\\s+(?:a|[aà]|at[eé])\\s+(?:${DIA_SRC})(?:-feira)?${E}|${B}(?:[aà]s|aos|nas|nos)\\s+(?:${DIA_SRC})s?(?:-feiras?)?${E}`, 'giu')
const CONDICIONAL_RE = /(?:^|[\s,])(?:se|caso|quando|assim\s+que)\s/iu
const RETORNO_HUMANO_RE = /vendedor|consultor|especialista|atendente|equipe|retorno|te\s+(?:chama|liga|responde)|entra(?:r)?\s+em\s+contato/iu

export interface EntradaRegrasQualidade {
  /** O que vai sair (ou a sugestão), DEPOIS das etapas anteriores do pipeline. */
  readonly mensagens: readonly string[]
  /**
   * Textos FIXOS do sistema que não são resposta do agente (abertura com o
   * aviso de privacidade — P4): não são avaliados.
   */
  readonly isentas?: readonly string[] | undefined
  /** Frases proibidas extras do número (`agente_config.compliance`). */
  readonly extras?: readonly string[] | undefined
  /** Perguntas já feitas pelo nosso lado ANTES de uma resposta do cliente. */
  readonly perguntasAnteriores?: readonly string[] | undefined
  /** Fontes de número do turno; null/ausente = desconhecidas, a regra não roda. */
  readonly fontes?: FontesDeNumeros | null | undefined
  /** Limite por mensagem (`agente_config.max_caracteres`). */
  readonly maxCaracteres?: number | undefined
  /** Houve saldo de estoque de ferramenta no turno — o MESMO critério do filtro P2 (escassez deixa de ser vetada). */
  readonly estoqueComFonte?: boolean | undefined
}

/**
 * Negação DEPOIS do termo, na mesma oração: "Pedido sem nota fiscal não é possível",
 * "venda sem nota não fazemos", "aprovação automática não temos, o financeiro analisa".
 */
const NEGACAO_DEPOIS_RE =
  /(?<![\p{L}\p{N}])(?:n[aã]o\s+(?:fazemos|vendemos|trabalhamos|emitimos|aceitamos|conseguimos|temos|[eé]\s+poss[ií]vel|d[aá])|nunca|jamais)(?![\p{L}\p{N}])/iu
function negadoDepois(frase: string, fimTermo: number): boolean {
  const resto = frase.slice(fimTermo).split(/[,;:—–()]/)[0] ?? ''
  return NEGACAO_DEPOIS_RE.test(resto)
}
/** Pergunta que OFERECE ("Podemos fazer sem nota?", "Fazemos sem nota sim, quer?") é a própria proposta. */
const OFERTA_EM_PERGUNTA_RE = /(?<![\p{L}])(?:quer|querem|podemos|fazemos|pode\s+ser)(?![\p{L}])/iu
/**
 * Constatação no passado ("seu cadastro foi aprovado hoje") é fato a conferir, não promessa — só com
 * "foi/ficou" + "hoje" e SEM "na hora/imediatamente/na certa" ("está aprovado na hora" é promessa).
 */
function constatacaoNoPassado(termo: string): boolean {
  return /(?<![\p{L}])(?:foi|ficou)\s/iu.test(termo) && /(?<![\p{L}])hoje(?![\p{L}])/iu.test(termo)
    && !/na\s+(?:mesma\s+)?hora|imediatamente|na\s+certa/iu.test(termo)
}

function palavrasProibidas(texto: string, extras: readonly string[] | undefined, estoqueComFonte: boolean): ViolacaoQualidade[] {
  const out: ViolacaoQualidade[] = []
  // A base + extras do filtro, de novo, sobre o texto final: se ainda cortaria, escapou.
  for (const o of filtrarSaida(texto, { extras, estoqueComFonte }).ocorrencias) {
    if (o.gravidade === 'INFO' || o.acao === 'registrado' || o.acao === 'reescrito') continue
    out.push({ regra: 'palavra_proibida', gravidade: o.gravidade, trecho: trechoDe(o.trecho ?? texto), detalhe: o.id })
  }
  for (const f of frases(texto)) {
    const pergunta = /\?\s*$/.test(f)
    for (const p of PROIBIDAS_QUALIDADE_B2B) {
      const m = p.re.exec(f)
      if (!m) continue
      if (!p.ignoraNegacao && (termoNegado(f, m.index) || negadoDepois(f, m.index + m[0].length))) continue
      let gravidade: GravidadeQualidade = p.gravidade
      if (gravidade === 'CRITICA') {
        // Pergunta: se oferece, é a proposta (CRÍTICA); senão, ALTA ("Seu pedido anterior ficou sem nota?").
        if (pergunta && !OFERTA_EM_PERGUNTA_RE.test(f)) gravidade = 'ALTA'
        else if (!pergunta && constatacaoNoPassado(m[0])) gravidade = 'ALTA'
      }
      out.push({ regra: 'palavra_proibida', gravidade, trecho: trechoDe(f), detalhe: p.id })
    }
  }
  return out
}

function promessas(texto: string): ViolacaoQualidade[] {
  const out: ViolacaoQualidade[] = []
  for (const f of frases(texto)) {
    if (/\?\s*$/.test(f)) continue
    // "de segunda a sexta", "às sextas", "aos sábados": horário de operação, não data prometida.
    const g = f.replace(FAIXA_DE_DIAS_RE, (x) => ' '.repeat(x.length))
    const m = PRAZO_ENTREGA_RE.exec(g)
    if (m && !termoNegado(g, m.index) && !CONDICIONAL_RE.test(g.slice(0, m.index + 1))) {
      out.push({ regra: 'promessa_prazo', gravidade: 'ALTA', trecho: trechoDe(f), detalhe: 'prazo de entrega por data' })
      continue
    }
    if (PROMESSA_PRAZO_RE.test(f) && RETORNO_HUMANO_RE.test(f)) {
      out.push({ regra: 'promessa_prazo', gravidade: 'ALTA', trecho: trechoDe(f), detalhe: 'prazo de retorno do atendimento' })
    }
  }
  return out
}

/**
 * Regras sobre a resposta inteira do turno (todas as mensagens). Pura.
 * - palavra proibida que ESCAPOU (base P2 + extras + lista B2B daqui);
 * - promessa de prazo por data ou de retorno do atendimento (ALTA);
 * - número de negócio sem fonte (bloqueante = CRÍTICA, senão ALTA) — só com `fontes`;
 * - pergunta repetida (MEDIA), mais de uma pergunta no turno (MEDIA), mensagem
 *   acima do limite do número (MEDIA).
 */
export function avaliarRegrasQualidade(e: EntradaRegrasQualidade): ViolacaoQualidade[] {
  const isentas = new Set((e.isentas ?? []).map((t) => t.trim()))
  const mensagens = e.mensagens.filter((m) => m.trim() && !isentas.has(m.trim()))
  const out: ViolacaoQualidade[] = []
  const max = e.maxCaracteres && e.maxCaracteres > 0 ? e.maxCaracteres : MAX_CARACTERES_PADRAO_QUALIDADE
  const perguntas: string[] = []
  for (const m of mensagens) {
    out.push(...palavrasProibidas(m, e.extras, e.estoqueComFonte === true), ...promessas(m))
    if (e.fontes) {
      for (const n of numerosSemFonte(m, e.fontes)) {
        const f = frases(m).find((x) => x.includes(n.trecho)) ?? n.trecho
        out.push({ regra: 'numero_sem_fonte', gravidade: n.bloqueante ? 'CRITICA' : 'ALTA', trecho: trechoDe(f), detalhe: n.trecho })
      }
    }
    if (m.length > max) {
      out.push({ regra: 'mensagem_longa', gravidade: 'MEDIA', trecho: trechoDe(m.slice(0, 120)), detalhe: `${m.length} caracteres (máx. ${max})` })
    }
    perguntas.push(...perguntasDe(m))
  }
  const anteriores = e.perguntasAnteriores ?? []
  // Pergunta de PEDIDO ("Posso fechar o pedido?") pode voltar: o pedido mudou entre um turno e
  // outro (a mesma exceção da trava P3).
  for (const p of perguntas) {
    if (!ehPerguntaDePedido(p) && anteriores.some((a) => mesmaPergunta(p, a))) out.push({ regra: 'pergunta_repetida', gravidade: 'MEDIA', trecho: trechoDe(p) })
  }
  if (perguntas.length > 1) {
    out.push({ regra: 'multiplas_perguntas', gravidade: 'MEDIA', trecho: trechoDe(perguntas.join(' | ')), detalhe: `${perguntas.length} perguntas` })
  }
  return out
}

/** A pior gravidade de uma lista (null = nenhuma). */
export function piorGravidade(vs: ReadonlyArray<{ readonly gravidade: string }>): GravidadeQualidade | null {
  let pior: GravidadeQualidade | null = null
  for (const v of vs) {
    const g = v.gravidade as GravidadeQualidade
    if (!(g in PESO)) continue
    if (!pior || PESO[g] > PESO[pior]) pior = g
  }
  return pior
}

/**
 * Perguntas que o nosso lado fez ANTES de uma resposta do cliente (ele já teve
 * a chance de responder): só essas contam como "já perguntado".
 */
export function perguntasJaRespondiveis(historico: ReadonlyArray<{ readonly de: 'cliente' | 'nos'; readonly texto: string }>): string[] {
  const out: string[] = []
  historico.forEach((f, i) => {
    if (f.de !== 'nos') return
    if (!historico.slice(i + 1).some((x) => x.de === 'cliente')) return
    out.push(...perguntasDe(f.texto))
  })
  return out
}

// ── amostra estável ─────────────────────────────────────────────────────────

/** FNV-1a de 32 bits → [0, 1): a mesma chave sempre dá o mesmo número. */
export function fracaoEstavel(chave: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < chave.length; i++) {
    h ^= chave.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h / 0x1_0000_0000
}

/** Amostra padrão por modo (ADR-031): sombra 1,0, assistido 0,2, autônomo 0,05. */
export const AMOSTRA_PADRAO_POR_MODO: Readonly<Record<ModoAgente, number>> = {
  desligado: 0, sombra: 1, assistido: 0.2, autonomo: 0.05,
}

/** A fração que vale: a do número (0..1) ou o padrão do modo. */
export function amostraEfetiva(configurada: number | null | undefined, modo: string | null | undefined): number {
  if (typeof configurada === 'number' && Number.isFinite(configurada)) return Math.min(1, Math.max(0, configurada))
  return AMOSTRA_PADRAO_POR_MODO[(modo ?? 'desligado') as ModoAgente] ?? 0
}

/** A conversa cai na amostra do juiz? Estável: a mesma conversa sempre cai, ou nunca cai. */
export function naAmostra(conversaId: string, amostra: number): boolean {
  if (amostra <= 0) return false
  return amostra >= 1 || fracaoEstavel(conversaId) < amostra
}

// ── rubrica do juiz ─────────────────────────────────────────────────────────

export const CRITERIOS_RUBRICA = ['aderencia', 'clareza', 'empatia', 'conducao', 'compliance'] as const
export type CriterioRubrica = (typeof CRITERIOS_RUBRICA)[number]

export const ROTULO_CRITERIO: Readonly<Record<CriterioRubrica, string>> = {
  aderencia: 'Aderência ao roteiro',
  clareza: 'Clareza',
  empatia: 'Empatia',
  conducao: 'Condução',
  compliance: 'Compliance',
}

export const DESCRICAO_CRITERIO: Readonly<Record<CriterioRubrica, string>> = {
  aderencia: 'aderência ao roteiro de venda B2B: entende a necessidade antes de oferecer, qualifica uma pergunta por vez, não pergunta o que o cliente já disse, recomenda com base no catálogo',
  clareza: 'clareza: mensagens curtas, linguagem simples, sem jargão, sem Markdown nem ambiguidade',
  empatia: 'empatia/rapport: usa o nome, reconhece o pedido do cliente, tom cordial e profissional, sem pressão',
  conducao: 'condução: cada resposta termina com um próximo passo claro (quantidade, confirmar, fechar o pedido)',
  compliance: 'compliance: nenhum preço, estoque, prazo ou desconto sem origem em ferramenta; nenhuma promessa de entrega, crédito ou preço; não nega ser assistente virtual; transfere ao humano quando deve',
}

export interface NotaCriterio {
  /** Inteiro 0–5. */
  readonly nota: number
  /** ≤ 280, mascarada. */
  readonly justificativa: string
}
export type NotasRubrica = Readonly<Record<CriterioRubrica, NotaCriterio>>

/** Instrução do juiz (ADR-031). `roteiro` = políticas/resumo do playbook do número, se houver. */
export function promptJuizQualidade(roteiro?: string | null): string {
  return [
    'Você avalia a qualidade do atendimento de um ASSISTENTE VIRTUAL de vendas B2B por WhatsApp (venda recorrente para lojistas e empresas).',
    'Avalie SOMENTE as falas marcadas AGENTE na transcrição (CLIENTE e VENDEDOR HUMANO são contexto). Dê nota INTEIRA de 0 a 5 para cada critério:',
    ...CRITERIOS_RUBRICA.map((c) => `- ${c}: ${DESCRICAO_CRITERIO[c]}`),
    '0 = ausente/grave, 3 = adequado, 5 = exemplar. Qualquer promessa de entrega, crédito ou preço, ou número sem origem => compliance no máximo 1.',
    `Justificativa: no máximo ${MAX_JUSTIFICATIVA} caracteres, em português, citando o trecho problemático quando houver. Nunca repita telefone, CPF, CNPJ ou e-mail.`,
    'Responda APENAS com JSON no formato:',
    `{${CRITERIOS_RUBRICA.map((c) => `"${c}":{"nota":0,"justificativa":"..."}`).join(',')}}`,
    ...(roteiro?.trim() ? ['', 'Políticas e roteiro da loja (referência):', roteiro.trim().slice(0, 6000)] : []),
  ].join('\n')
}

/**
 * JSON Schema da saída do juiz — SIMPLES de propósito (sem min/max/maxLength):
 * fornecedor que recusa schema degradaria o formato; os limites são aplicados
 * em `interpretarRubrica`.
 */
export function esquemaRubricaJson(): Record<string, unknown> {
  const nota = {
    type: 'object',
    properties: { nota: { type: 'integer' }, justificativa: { type: 'string' } },
    required: ['nota', 'justificativa'],
    additionalProperties: false,
  }
  return {
    type: 'object',
    properties: Object.fromEntries(CRITERIOS_RUBRICA.map((c) => [c, nota])),
    required: [...CRITERIOS_RUBRICA],
    additionalProperties: false,
  }
}

const notaBruta = z.object({ nota: z.coerce.number(), justificativa: z.string().optional().default('') })
const rubricaBruta = z.object(Object.fromEntries(CRITERIOS_RUBRICA.map((c) => [c, notaBruta])) as Record<CriterioRubrica, typeof notaBruta>)

/** Extrai o primeiro objeto JSON de um texto ("```json {…} ```" ou prosa em volta). */
function jsonDe(v: unknown): unknown {
  if (typeof v !== 'string') return v
  const i = v.indexOf('{'), j = v.lastIndexOf('}')
  if (i < 0 || j <= i) return null
  try { return JSON.parse(v.slice(i, j + 1)) } catch { return null }
}

/**
 * A saída do juiz → notas normalizadas (inteiro 0–5, justificativa mascarada
 * ≤ 280). null = fora do formato (falta critério, nota não numérica).
 */
export function interpretarRubrica(saida: unknown): NotasRubrica | null {
  const r = rubricaBruta.safeParse(jsonDe(saida))
  if (!r.success) return null
  const out = {} as Record<CriterioRubrica, NotaCriterio>
  for (const c of CRITERIOS_RUBRICA) {
    const n = r.data[c].nota
    if (!Number.isFinite(n)) return null
    const j = mascararTextoQualidade(r.data[c].justificativa.replace(/\s+/g, ' ').trim())
    out[c] = { nota: Math.min(5, Math.max(0, Math.round(n))), justificativa: j.slice(0, MAX_JUSTIFICATIVA) }
  }
  return out
}

/** Média simples das 5 notas, 2 casas. */
export function notaMedia(notas: NotasRubrica): number {
  const s = CRITERIOS_RUBRICA.reduce((acc, c) => acc + notas[c].nota, 0)
  return Math.round((s / CRITERIOS_RUBRICA.length) * 100) / 100
}

// ── amostra semanal (CSV e revisão humana) ──────────────────────────────────

export const TAMANHO_AMOSTRA_SEMANAL = 20
/** Quantas "ALTA ou nota ≤ 3" entram, no máximo, depois das CRÍTICAs. */
export const MAX_ALTA_OU_NOTA_BAIXA = 8
export const NOTA_BAIXA = 3

export const MOTIVOS_AMOSTRA = ['critica', 'alta_ou_nota_baixa', 'aleatoria'] as const
export type MotivoAmostra = (typeof MOTIVOS_AMOSTRA)[number]

export interface ConversaAvaliada {
  readonly conversaId: string
  readonly piorGravidade: GravidadeQualidade | null
  /** A menor nota média do juiz na semana; null = não julgada. */
  readonly menorNota: number | null
}

/**
 * A amostra da semana de UM número, na ordem do ADR-031:
 *   1. todas as conversas com CRÍTICA (até o tamanho);
 *   2. ALTA ou nota ≤ 3, até `MAX_ALTA_OU_NOTA_BAIXA`;
 *   3. aleatórias até `TAMANHO_AMOSTRA_SEMANAL` — "aleatórias" ESTÁVEIS pela
 *      `semente` (a semana): exportar duas vezes dá o mesmo arquivo.
 * Dentro de cada grupo: CRÍTICA/ALTA pela menor nota; aleatórias pelo hash.
 */
export function ordenarAmostraSemanal<T extends ConversaAvaliada>(
  itens: readonly T[], semente: string, tamanho = TAMANHO_AMOSTRA_SEMANAL,
): Array<T & { readonly motivo: MotivoAmostra }> {
  const porNota = (a: T, b: T) => (a.menorNota ?? 6) - (b.menorNota ?? 6) || (a.conversaId < b.conversaId ? -1 : 1)
  const criticas = itens.filter((i) => i.piorGravidade === 'CRITICA').sort(porNota)
  const resto = itens.filter((i) => i.piorGravidade !== 'CRITICA')
  const baixas = resto.filter((i) => i.piorGravidade === 'ALTA' || (i.menorNota !== null && i.menorNota <= NOTA_BAIXA)).sort(porNota)
  const out: Array<T & { motivo: MotivoAmostra }> = []
  for (const c of criticas) { if (out.length >= tamanho) break; out.push({ ...c, motivo: 'critica' }) }
  const usadas = new Set(out.map((o) => o.conversaId))
  let nBaixas = 0
  for (const c of baixas) {
    if (out.length >= tamanho || nBaixas >= MAX_ALTA_OU_NOTA_BAIXA) break
    out.push({ ...c, motivo: 'alta_ou_nota_baixa' }); usadas.add(c.conversaId); nBaixas++
  }
  const aleatorias = itens.filter((i) => !usadas.has(i.conversaId) && i.piorGravidade !== 'CRITICA')
    .map((i) => ({ i, h: fracaoEstavel(`${semente}:${i.conversaId}`) }))
    .sort((a, b) => a.h - b.h)
  for (const { i } of aleatorias) { if (out.length >= tamanho) break; out.push({ ...i, motivo: 'aleatoria' }) }
  return out
}

// ── contratos HTTP (console e raias seguintes) ──────────────────────────────

/** Um item de GET /v1/agente/qualidade. */
export interface AvaliacaoQualidadeDto {
  readonly id: string
  readonly decisaoId: string
  readonly conversaId: string
  readonly canalId: string
  readonly sessaoId: string | null
  readonly origem: OrigemAvaliacao
  readonly tipo: TipoAvaliacao
  readonly gatilho: GatilhoAvaliacao
  readonly violacoes: ReadonlyArray<ViolacaoQualidade & { readonly corrigida?: boolean | undefined }>
  readonly piorGravidade: GravidadeQualidade | null
  readonly notas: NotasRubrica | null
  readonly notaMedia: number | null
  readonly acao: AcaoAvaliacao | null
  readonly modelo: string | null
  readonly custoCentavos: number
  readonly erro: string | null
  readonly criadoEm: string
}

/** GET /v1/agente/qualidade/resumo. */
export interface ResumoQualidadeDto {
  readonly periodoDias: number
  readonly turnosAvaliados: number
  readonly porGravidade: Readonly<Record<GravidadeQualidade, number>>
  readonly pausas: number
  readonly naoEnvie: number
  readonly julgadas: number
  readonly notaMedia: number | null
  readonly mediaPorCriterio: Readonly<Record<CriterioRubrica, number | null>> | null
  readonly porRegra: ReadonlyArray<{ readonly regra: RegraQualidade; readonly quantidade: number }>
  readonly amostra: number | null
  readonly amostraPadrao: number
  readonly juiz: {
    readonly disponivel: boolean
    readonly motivoIndisponivel: string | null
    readonly gastoMesCentavos: number
    readonly tetoMesCentavos: number | null
    readonly pausadoPorTeto: boolean
  }
}
