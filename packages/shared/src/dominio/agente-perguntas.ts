import { SLOTS_QUALIFICACAO, type SlotQualificacao } from './agente-vendedor.js'
import { validarCnpj } from './documento.js'

/**
 * PERGUNTA REPETIDA E SLOTS DETERMINÍSTICOS (raia P3, docs/plano-port-playbook-am.md; ADR-029).
 *
 * Porte de `AMConsorcio agent-worker/src/agent/perguntas.ts` (playbook §3.8, §12 #3) para o B2B.
 *
 * Caso real (AM, Sonnet/Bedrock): o bot perguntou "Você já conhece como o consórcio funciona?", a
 * cliente respondeu OUTRA coisa ("crédito de 80 mil e prazo de 6 meses") e o bot fez a MESMA
 * pergunta no turno seguinte. No B2B: "É para revenda ou para uso da própria empresa?" → "preciso de
 * 50 caixas até sexta" → a mesma pergunta de novo. Três peças, todas em código:
 *
 *   1. o que o cliente traz por conta própria vira slot respondido (`extrairSlotsDoCliente`);
 *   2. o estado guarda a última pergunta do agente (sobrevive a restart e a janela curta);
 *   3. antes do envio, pergunta igual à do turno anterior sai e, se a mensagem ficar sem próximo
 *      passo, entra a pergunta do próximo slot aberto — ou uma neutra (`evitarPerguntaRepetida`).
 *
 * ⚠️ TypeScript puro: consumido por API, console e app.
 * ⚠️ CNPJ vira 'informado' — os dígitos nunca saem daqui (o estado aparece na auditoria).
 */

// ── texto ───────────────────────────────────────────────────────────────────

/** Minúsculas, sem acento, sem pontuação e com espaços simples. */
export function normalizarPergunta(t: string): string {
  return t
    .normalize('NFD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** Perguntas de um texto (cada trecho terminado em "?"). */
export function perguntasDe(texto: string): string[] {
  return (texto.match(/[^.!?\n]*\?+/gu) ?? []).map((p) => p.trim()).filter((p) => p.length > 1)
}

const STOP = new Set(
  ('a o as os de da do das dos e em no na nos nas um uma uns umas que pra para por com se me te voce vc ' +
    'seu sua seus suas qual quais como quanto quanta isso esse essa este esta ja ai entao tem ter ou ' +
    'mais muito bem sim nao eh ser vai vou')
    .split(' '),
)

/** Palavras significativas (sem acento, sem stopwords, 3+ letras). */
export function tokensPergunta(t: string): Set<string> {
  return new Set(normalizarPergunta(t).split(' ').filter((w) => w.length > 2 && !STOP.has(w)))
}

/** Jaccard entre dois conjuntos de palavras. */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

/** Limiar da trava (o mesmo da AM; a regra de qualidade da P12 usa este). */
export const LIMIAR_PERGUNTA_REPETIDA = 0.7

/** Mesma pergunta: idêntica depois de normalizada ou com as mesmas palavras (Jaccard ≥ 0,7). */
export function mesmaPergunta(a: string, b: string): boolean {
  const na = normalizarPergunta(a)
  if (na && na === normalizarPergunta(b)) return true
  const ta = tokensPergunta(a)
  if (ta.size < 2) return false
  return jaccard(ta, tokensPergunta(b)) >= LIMIAR_PERGUNTA_REPETIDA
}

// ── roteiro por slot ────────────────────────────────────────────────────────

/**
 * A pergunta canônica de cada slot — o que entra no lugar da repetida quando a mensagem ficaria
 * sem próximo passo. Uma pergunta por slot, curta, sem número (o guardrail de R$ não tem o que
 * barrar) e diferentes entre si (nenhum par passa do limiar).
 */
export const PERGUNTA_DO_SLOT: Readonly<Record<SlotQualificacao, string>> = {
  tipoCompra: 'É para revenda ou para uso da própria empresa?',
  cidade: 'Para qual cidade seria a entrega?',
  volume: 'Qual quantidade você está pensando?',
  prazo: 'Para quando você precisa?',
  orcamento: 'Você tem um valor em mente para esse pedido?',
  necessidade: 'O que você está procurando hoje?',
  cnpj: 'Pode me passar o CNPJ da empresa?',
}

/** Próximo passo quando não há slot aberto: neutras, em ordem (a 2ª só se a 1ª acabou de sair). */
export const PERGUNTAS_NEUTRAS = [
  'Me conta um pouco mais do que você precisa?',
  'Posso ajudar com mais alguma coisa?',
] as const
export const PERGUNTA_NEUTRA = PERGUNTAS_NEUTRAS[0]

/** A que slot uma pergunta do agente se refere (palavra-chave; a ordem desempata). */
const PISTAS_DO_SLOT: readonly (readonly [SlotQualificacao, RegExp])[] = [
  ['cnpj', /\bcnpj\b/],
  ['tipoCompra', /\b(?:revend\w*|revenda|uso proprio|consumo|propria empresa|uso da empresa)\b/],
  ['cidade', /\b(?:cidade|regiao|bairro|cep|onde (?:voce|vc) (?:fica|esta)|entrega\w* (?:em|para) onde)\b/],
  ['orcamento', /\b(?:orcamento|verba|valor em mente|investir|quanto (?:pretende|quer|pode) (?:gastar|pagar))\b/],
  ['volume', /\b(?:quantidade|quantas|quantos|volume|caixas|unidades|pecas)\b/],
  ['prazo', /\b(?:prazo|para quando|pra quando|quando (?:voce |vc )?precisa|ate quando|data)\b/],
  ['necessidade', /\b(?:procurando|procura|buscando|necessidade|o que (?:voce |vc )?precisa)\b/],
]

/** Slot do roteiro a que a pergunta corresponde; null quando não é de qualificação. */
export function slotDaPergunta(pergunta: string): SlotQualificacao | null {
  const t = normalizarPergunta(pergunta)
  for (const [slot, re] of PISTAS_DO_SLOT) if (re.test(t)) return slot
  return null
}

/** Primeiro slot do canal sem resposta, pulando os de `excluir`. */
export function proximoSlotAberto(
  slotsDoCanal: readonly string[], respondidos: readonly string[], excluir: readonly string[] = [],
): SlotQualificacao | null {
  const fora = new Set([...respondidos, ...excluir])
  for (const s of slotsDoCanal) if (ehSlot(s) && !fora.has(s)) return s
  return null
}

export function ehSlot(v: unknown): v is SlotQualificacao {
  return typeof v === 'string' && (SLOTS_QUALIFICACAO as readonly string[]).includes(v)
}

// ── trava antes do envio ────────────────────────────────────────────────────

export interface ContextoPerguntaRepetida {
  /** Falas (ou perguntas) do turno anterior do agente; texto com várias perguntas vale. */
  readonly perguntasAnteriores: readonly string[]
  /** Slots que já têm resposta (cliente, modelo, cadastro). */
  readonly slotsRespondidos: readonly string[]
  /** `agente_config.qualificacao`, na ordem em que o canal quer perguntar. */
  readonly slotsDoCanal: readonly string[]
  /**
   * Completar com próximo passo quando a resposta ficar sem pergunta (padrão true). Em handoff é
   * false: "vou te passar para a equipe" não termina com pergunta de qualificação.
   */
  readonly proximoPasso?: boolean | undefined
}

export interface ResultadoPerguntaRepetida {
  readonly texto: string
  /** Perguntas tiradas por repetir as do turno anterior. */
  readonly removidas: readonly string[]
  /** O que entrou no lugar (pergunta do próximo slot ou neutra); null = nada entrou. */
  readonly substituta: string | null
}

export interface ResultadoPerguntaRepetidaMensagens {
  /** Mensagens que sobraram (bolha que ficou vazia sai). */
  readonly mensagens: readonly string[]
  readonly removidas: readonly string[]
  readonly substituta: string | null
}

/** A resposta repete alguma pergunta do turno anterior? (barato; decide se vale buscar mais contexto). */
export function temPerguntaRepetida(mensagens: readonly string[], perguntasAnteriores: readonly string[]): boolean {
  const antes = perguntasAnteriores.flatMap((a) => perguntasDe(a))
  if (!antes.length) return false
  return mensagens.some((m) => perguntasDe(m).some((p) => antes.some((a) => mesmaPergunta(p, a))))
}

function limpar(t: string): string {
  return t
    .split('\n')
    .map((l) => l.replace(/[ \t]{2,}/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * A trava sobre as bolhas de um turno: tira de cada uma as perguntas iguais às do turno anterior do
 * agente e mantém o resto. Se o turno inteiro ficar sem pergunta, a última bolha ganha a pergunta do
 * próximo slot aberto (fora o que acabou de ser perguntado) — nunca a mesma pergunta em dois turnos
 * seguidos; sem slot aberto, uma neutra que também não repita.
 */
export function evitarPerguntaRepetidaNasMensagens(
  mensagens: readonly string[], ctx: ContextoPerguntaRepetida,
): ResultadoPerguntaRepetidaMensagens {
  const antes = ctx.perguntasAnteriores.flatMap((a) => perguntasDe(a))
  const intacto = { mensagens, removidas: [], substituta: null }
  if (!antes.length) return intacto
  const removidas: string[] = []
  const saida: string[] = []
  for (const m of mensagens) {
    const daqui = perguntasDe(m).filter((p) => antes.some((a) => mesmaPergunta(p, a)))
    if (!daqui.length) { saida.push(m); continue }
    removidas.push(...daqui)
    let t = m
    for (const p of daqui) t = t.replace(p, ' ')
    t = limpar(t)
    if (t) saida.push(t)
  }
  if (!removidas.length) return intacto

  let substituta: string | null = null
  const semPergunta = !saida.some((m) => perguntasDe(m).length > 0)
  if (semPergunta && ctx.proximoPasso !== false) {
    const jaFeitas = [...antes, ...removidas]
    const repete = (s: string) => jaFeitas.some((a) => mesmaPergunta(s, a))
    const excluir = jaFeitas.map(slotDaPergunta).filter((s): s is SlotQualificacao => s !== null)
    const slot = proximoSlotAberto(ctx.slotsDoCanal, ctx.slotsRespondidos, excluir)
    const doSlot = slot ? PERGUNTA_DO_SLOT[slot] : null
    substituta = doSlot && !repete(doSlot) ? doSlot : (PERGUNTAS_NEUTRAS.find((n) => !repete(n)) ?? null)
    if (substituta) {
      const ultima = saida.pop()
      saida.push(ultima ? `${ultima}${/[.!?…]$/u.test(ultima) ? '' : '.'} ${substituta}` : substituta)
    }
  }
  return { mensagens: saida, removidas, substituta }
}

/** A trava sobre um texto só (contrato da P3). */
export function evitarPerguntaRepetida(texto: string, ctx: ContextoPerguntaRepetida): ResultadoPerguntaRepetida {
  const r = evitarPerguntaRepetidaNasMensagens([texto], ctx)
  return { texto: r.mensagens.join('\n'), removidas: r.removidas, substituta: r.substituta }
}

// ── o que o cliente disse ───────────────────────────────────────────────────

/**
 * Slots que o cliente trouxe na mensagem — só o inequívoco; o modelo continua declarando o resto
 * em `slots` da resposta. Valores curtos, sem PII:
 *   volume   → o trecho ("50 caixas")          prazo → o trecho ("até sexta")
 *   orcamento → 'informado' (valor em R$ no contexto do modelo viraria número sem fonte)
 *   tipoCompra → 'revenda' | 'consumo_final' (os valores de `extracao.ts`)
 *   cnpj     → 'informado' com DV válido — NUNCA os dígitos
 */
export type SlotsDoCliente = Partial<Record<SlotQualificacao, string>>

/** Minúsculas sem acento, preservando posições (cada caractere vira exatamente um). */
function dobrar(t: string): string {
  let s = ''
  for (const c of t) {
    const d = c.normalize('NFD').replace(/[\u0300-\u036f]/gu, '').toLowerCase()
    const l = c.toLowerCase()
    s += d.length === c.length ? d : l.length === c.length ? l : ' '.repeat(c.length)
  }
  return s
}

const NUM = String.raw`(?:\d+(?:[.,]\d+)?|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|doze|quinze|vinte|trinta|cinquenta|cem|duzentos|duzentas|quinhentos|quinhentas|mil)`
const UNIDADES = String.raw`(?:caixas?|cx|unidades?|und|un|pecas?|pcs?|pares?|fardos?|pacotes?|sacos?|sacas?|kg|quilos?|litros?|lts?|duzias?|paletes?|pallets?|rolos?|metros?|galoes?|latas?|frascos?|garrafas?|cartelas?|displays?|kits?|grades?|bobinas?|resmas?|toneladas?)`
/** "comprei 10 caixas", "da outra vez 20 caixas": passado não é o volume de agora. */
const PASSADO = /\b(?:comprei|comprou|compramos|comprava|pedi|pedimos|recebi|recebemos|chegaram|chegou|sobrou|sobraram|faltou|faltaram|ultima vez|da outra vez|mes passado|semana passada)\b[^.!?\n]{0,25}$/

const DIA_SEMANA = String.raw`(?:segunda|terca|quarta|quinta|sexta|sabado|domingo)(?:[- ]feira)?`
const PRAZOS: readonly RegExp[] = [
  /\b(?:sem pressa|nao tenho pressa|sem urgencia|nao e urgente|com calma)\b/,
  /\b(?:urgente|o quanto antes|o mais rapido(?: possivel)?|pra ja|para ja|pra ontem|(?:pra|para) hoje|ainda hoje|hoje ainda)\b/,
  new RegExp(String.raw`\b(?:ate|pra|para|antes d[aeo]|na|no)\s+(?:a\s+|o\s+)?(?:proxim[ao]\s+|essa\s+|esta\s+)?${DIA_SEMANA}\b`),
  /\b(?:ate|pra|para)?\s*(?:amanha|depois de amanha)\b/,
  /\b(?:(?:ate|pra|para|na)\s+)?(?:semana que vem|proxima semana|essa semana|esta semana|fim de semana|final de semana)\b/,
  /\b(?:(?:ate|pra|para|no)\s+)?(?:mes que vem|proximo mes|fim do mes|final do mes|inicio do mes)\b/,
  /\bate (?:o )?dia \d{1,2}(?:\/\d{1,2})?\b/,
  /\bate \d{1,2}\/\d{1,2}\b/,
  new RegExp(String.raw`\b(?:em|dentro de|daqui a|nos proximos)\s+${NUM}\s+(?:dias?(?: uteis)?|semanas?|meses?)\b`),
]

const DINHEIRO = /\br\$\s?\d|\b\d[\d.,]*\s?(?:mil\s+)?reais\b/
const ORCAMENTO_CONTEXTO = new RegExp(String.raw`\b(?:orcamento|verba|budget|gastar|investir)\b[^.!?\n]{0,30}?(?:\b\d[\d.,]*|\b${NUM}\s+mil)\b(?!\s*(?:mil\s+)?${UNIDADES}\b)`)

export function extrairSlotsDoCliente(texto: string): SlotsDoCliente {
  const r: SlotsDoCliente = {}
  if (!texto) return r
  // CNPJ primeiro, e os dígitos saem do texto antes das outras leituras (nem prazo, nem volume).
  let base = texto
  for (const m of texto.matchAll(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g)) {
    if (validarCnpj(m[0])) r.cnpj = 'informado'
    base = base.slice(0, m.index) + ' '.repeat(m[0].length) + base.slice(m.index + m[0].length)
  }
  // Telefone/CPF também não são volume nem prazo.
  base = base.replace(/\b\d{9,}\b|\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, (s) => ' '.repeat(s.length))
  const t = dobrar(base)

  // tipoCompra: "não é pra revenda" é consumo — a negação vem antes.
  if (/\b(?:nao (?:e|vou|vamos) (?:pra |para )?revend\w*|nao e (?:pra |para )?revenda|uso proprio|consumo (?:proprio|final|interno)|uso (?:interno|da empresa|na empresa)|(?:pra|para) (?:uso|consumo) (?:da|na) (?:empresa|loja))\b/.test(t)) {
    r.tipoCompra = 'consumo_final'
  } else if (/\b(?:revend\w*|(?:pra|para) revenda|sou lojista|tenho (?:uma )?loja|minha loja|meus clientes)\b/.test(t)) {
    r.tipoCompra = 'revenda'
  }

  const reVolume = new RegExp(String.raw`\b${NUM}(?:\s+mil)?\s+(?:de\s+)?${UNIDADES}\b`, 'g')
  for (const m of t.matchAll(reVolume)) {
    if (PASSADO.test(t.slice(Math.max(0, m.index - 40), m.index))) continue
    r.volume = base.slice(m.index, m.index + m[0].length).trim().slice(0, 60)
    break
  }

  for (const re of PRAZOS) {
    const m = re.exec(t)
    if (!m) continue
    const antes = t.slice(Math.max(0, m.index - 12), m.index)
    if (/\b(?:ha|faz|desde)\s*$/.test(antes)) continue
    const trecho = base.slice(m.index, m.index + m[0].length).trim()
    if (trecho) { r.prazo = trecho.slice(0, 60); break }
  }

  if (DINHEIRO.test(t) || ORCAMENTO_CONTEXTO.test(t)) r.orcamento = 'informado'
  return r
}

/** Rótulo curto para a instrução do turno ("volume: 50 caixas", "CNPJ informado"). */
export function descreverSlot(slot: SlotQualificacao, valor: string): string {
  if (slot === 'cnpj') return 'CNPJ informado'
  if (slot === 'orcamento') return 'orçamento informado'
  if (slot === 'tipoCompra') return valor === 'revenda' ? 'compra para revenda' : valor === 'consumo_final' ? 'compra para uso próprio' : `tipo de compra: ${valor}`
  return `${slot}: ${valor}`
}

// ── estado entre turnos (`agente_sessao.estado_agente.perguntas`) ──────────

export interface UltimaPergunta {
  readonly texto: string
  readonly slot: SlotQualificacao | null
  /** ISO 8601. */
  readonly em: string
}

export interface EstadoPerguntas {
  /** Última pergunta que o agente ENVIOU (autônomo); null = o último turno não perguntou nada. */
  readonly ultima: UltimaPergunta | null
  /** Slots que o cliente trouxe, lidos em código (não pelo modelo). */
  readonly respondidos: SlotsDoCliente
}

export const ESTADO_PERGUNTAS_VAZIO: EstadoPerguntas = { ultima: null, respondidos: {} }

/** Leitura tolerante do jsonb: qualquer coisa fora do formato vira o vazio. */
export function lerEstadoPerguntas(v: unknown): EstadoPerguntas {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return ESTADO_PERGUNTAS_VAZIO
  const o = v as Record<string, unknown>
  const u = o['ultima'] as Record<string, unknown> | null | undefined
  const ultima: UltimaPergunta | null = u && typeof u === 'object' && typeof u['texto'] === 'string' && u['texto']
    ? { texto: u['texto'], slot: ehSlot(u['slot']) ? u['slot'] : null, em: typeof u['em'] === 'string' ? u['em'] : '' }
    : null
  const respondidos: SlotsDoCliente = {}
  const rb = o['respondidos']
  if (rb && typeof rb === 'object' && !Array.isArray(rb)) {
    for (const [k, val] of Object.entries(rb as Record<string, unknown>)) {
      if (ehSlot(k) && typeof val === 'string' && val) respondidos[k] = val.slice(0, 60)
    }
  }
  return { ultima, respondidos }
}
