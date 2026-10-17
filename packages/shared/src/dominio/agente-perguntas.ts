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

/**
 * Perguntas de um texto (cada trecho terminado em "?"), recortadas do texto ORIGINAL.
 * ⚠️ URL não é pergunta: o "?" de `https://loja.com/p?id=1` não abre nem fecha pergunta — a URL
 *    vira um separador (mesmo tamanho) antes de procurar, e a pergunta começa depois dela. Assim
 *    a remoção nunca corta um link ao meio.
 */
export function perguntasDe(texto: string): string[] {
  const mascarado = texto.replace(/https?:\/\/\S+/giu, (u) => '.'.repeat(u.length))
  const r: string[] = []
  for (const m of mascarado.matchAll(/[^.!?\n]*\?+/gu)) {
    const p = texto.slice(m.index, m.index + m[0].length).trim()
    if (p.length > 1) r.push(p)
  }
  return r
}

const STOP = new Set(
  ('a o as os de da do das dos e em no na nos nas um uma uns umas que pra para por com se me te voce vc ' +
    'seu sua seus suas qual quais como quanto quanta isso esse essa este esta ja ai entao tem ter ou ' +
    'mais muito bem sim nao eh ser vai vou')
    .split(' '),
)

/**
 * Palavras significativas (sem acento, sem stopwords, 3+ letras) e TODOS os números.
 * ⚠️ O número fica: "Confirma 10 caixas?" e "Confirma 20 caixas?" são perguntas diferentes.
 */
export function tokensPergunta(t: string): Set<string> {
  return new Set(normalizarPergunta(t).split(' ').filter((w) => (/^\d+$/.test(w) || w.length > 2) && !STOP.has(w)))
}

function numerosDe(t: string): string {
  return [...new Set(normalizarPergunta(t).split(' ').filter((w) => /^\d+$/.test(w)))].sort().join(',')
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

/**
 * Mesma pergunta: idêntica depois de normalizada ou com as mesmas palavras (Jaccard ≥ 0,7).
 * Conjuntos de números diferentes nunca são a mesma pergunta.
 */
export function mesmaPergunta(a: string, b: string): boolean {
  if (numerosDe(a) !== numerosDe(b)) return false
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
  orcamento: 'Você tem um valor em mente para essa compra?',
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

/**
 * Pergunta de PEDIDO (confirmar, fechar, incluir, ajustar…): a trava nunca a remove. Repetir
 * "Posso fechar o pedido?" depois de mudar o pedido é o fluxo certo — trocá-la por uma pergunta
 * de qualificação desmontaria a confirmação (revisão adversarial da P3, achado ALTA).
 *
 * ⚠️ Exige VERBO DE AÇÃO, não a palavra "pedido" solta: "Qual a quantidade do pedido?" é
 *    qualificação. E a pergunta não pode ser de outro slot que não volume: "Pode confirmar a
 *    cidade de entrega?" e "Me confirma o CNPJ?" continuam sob a trava (re-revisão da P3).
 */
const VERBOS_DE_PEDIDO = /\b(?:confirm\w*|fech\w*|inclu\w*|adicion\w*|acrescent\w*|finaliz\w*|ajust\w*|remov\w*|troc\w*)\b/
export function ehPerguntaDePedido(pergunta: string): boolean {
  if (!VERBOS_DE_PEDIDO.test(normalizarPergunta(pergunta))) return false
  const slot = slotDaPergunta(pergunta)
  return slot === null || slot === 'volume'
}

/**
 * A trava pode tirar `p`? Só se repete uma pergunta do turno anterior E é de qualificação
 * (mapeada a slot, comparada por Jaccard) ou idêntica depois de normalizada. Pergunta de pedido,
 * nunca; números diferentes, nunca (já em `mesmaPergunta`).
 */
export function perguntaRemovivel(p: string, anteriores: readonly string[]): boolean {
  if (ehPerguntaDePedido(p)) return false
  const np = normalizarPergunta(p)
  const deSlot = slotDaPergunta(p) !== null
  return anteriores.some((a) => mesmaPergunta(p, a) && (deSlot || np === normalizarPergunta(a)))
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
  return mensagens.some((m) => perguntasDe(m).some((p) => perguntaRemovivel(p, antes)))
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
    const daqui = perguntasDe(m).filter((p) => perguntaRemovivel(p, antes))
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
  // Nada sobrou (handoff só com a repetida, neutras esgotadas): melhor a original que bolha vazia.
  if (!saida.length) return intacto
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

// ⚠️ NA DÚVIDA, NÃO EXTRAI: slot extraído fica na sessão e o agente para de perguntar aquilo.
//    Um falso positivo ("galão de 5 litros" como volume) é pior que deixar o modelo perguntar.

/** Sem "um/uma": "tem uma caixa com 12?" não é volume. */
const NUM = String.raw`(?:\d+(?:[.,]\d+)?|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|doze|quinze|vinte|trinta|cinquenta|cem|duzentos|duzentas|quinhentos|quinhentas|mil)`
const UNIDADES = String.raw`(?:caixas?|cx|unidades?|und|un|pecas?|pcs?|pares?|fardos?|pacotes?|sacos?|sacas?|kg|quilos?|litros?|lts?|duzias?|paletes?|pallets?|rolos?|metros?|galoes?|latas?|frascos?|garrafas?|cartelas?|displays?|kits?|grades?|bobinas?|resmas?|toneladas?)`
/**
 * Na mesma frase, a quantidade NÃO é o volume que o cliente quer agora: passado ("comprei 10
 * caixas", "50 caixas ano passado"), estoque ou venda dele ("tenho/temos", "a gente vende"),
 * proporção ("6 unidades por caixa", "12 unidades cada"), pergunta de preço ("1 kg dá quanto"),
 * medida ("3 metros de distância", "2 kg de diferença"). Vale com ou sem pergunta pendente.
 */
const NAO_VOLUME = /\b(?:comprei|comprou|compramos|comprava|pedi|pedimos|recebi|recebemos|chegaram|chegou|sobrou|sobraram|faltou|faltaram|ultima vez|da outra vez|mes passado|mes retrasado|ano passado|semana passada|por caixa|por pacote|por fardo|por unidade|cada|em estoque|por mes|por semana|por dia|de diferenca|de distancia|quanto|quanta|tenho|temos|vende|vendemos|vendo)\b/
/** Volume com intenção de compra antes da quantidade, na mesma frase. */
const INTENCAO_VOLUME = /\b(?:preciso|precisamos|precisaria|necessito|quero|queremos|queria|gostaria|vou querer|vamos querer|levar|pegar|pego|me ve|manda|mande|separa|separe|separar|pedir|encomendar|comprar|fecha|fechar|fechamos|seriam|serao|vai ser|vao ser)\b/
/** Medida sozinha ("5 litros") pode ser o tamanho que o cliente procura — sozinha não é volume. */
const MEDIDA = /^(?:kg|quilos?|litros?|lts?|metros?|toneladas?)$/
/** "o de 5 litros", "a de 2 kg": escolha de variante, não quantidade — barra até com pergunta pendente. */
const ARTIGO_DE_ANTES = /\b(?:o|a|os|as)\s+de\s+$/
/** Embalagem logo antes: "galão de 5 litros", "saco de 25 kg", "caixa com 12" — é tamanho, não volume. */
const EMBALAGEM_ANTES = /\b(?:galao|galoes|saco|sacos|saca|sacas|caixa|caixas|cx|pacote|pacotes|fardo|fardos|frasco|frascos|garrafa|garrafas|lata|latas|balde|baldes|embalagem|embalagens|pote|potes|rolo|rolos|bobina|bobinas|kit|kits|display|displays|refil|tambor|bombona|tamanho)\s+(?:de|com)\s+$/

const DIA = String.raw`(?:segunda|terca|quarta|quinta|sexta|sabado|domingo)`
/** Valem sozinhos: o cliente falou de urgência ou da falta dela. */
const PRAZOS_DIRETOS: readonly RegExp[] = [
  /\b(?:sem pressa|nao tenho pressa|sem urgencia|nao e urgente)\b/,
  /\b(?:urgente|o quanto antes|o mais rapido(?: possivel)?|pra ontem)\b/,
]
/** Só contam numa frase com intenção de prazo e sem despedida. */
const PRAZOS_COM_INTENCAO: readonly RegExp[] = [
  // Dia da semana com "até/para" antes ou com "feira": "vou na segunda opção" não é prazo.
  new RegExp(String.raw`\b(?:ate|pra|para|antes d[aeo])\s+(?:a\s+|o\s+)?(?:proxim[ao]\s+)?${DIA}(?:[- ]feira)?\b`),
  new RegExp(String.raw`\b${DIA}[- ]feira\b`),
  /\b(?:(?:ate|pra|para)\s+)?(?:depois de amanha|amanha)\b/,
  /\b(?:(?:ate|pra|para|na)\s+)?(?:semana que vem|proxima semana|essa semana|esta semana)\b/,
  /\b(?:(?:ate|pra|para|no)\s+)?(?:mes que vem|proximo mes|fim do mes|final do mes|inicio do mes)\b/,
  /\b(?:pra|para) hoje\b|\bainda hoje\b|\bhoje ainda\b/,
  /\bate (?:o )?dia \d{1,2}(?:\/\d{1,2})?\b/,
  /\bate \d{1,2}\/\d{1,2}\b/,
  new RegExp(String.raw`\b(?:em|dentro de|daqui a|nos proximos)\s+${NUM}\s+(?:dias?(?: uteis)?|semanas?|meses?)\b`),
]
const INTENCAO_PRAZO = /\b(?:preciso|precisamos|precisa|necessito|quero|queremos|entrega\w*|entregar|receber|chegar|chegue|pode ser|consegue\w*|prazo|tem que|tenho que|seriam|serao|vai ser|vao ser)\b/
/** Despedida ou agenda do próprio cliente: "obrigado, até amanhã!", "amanhã te mando o CNPJ", "segunda-feira tô na loja". */
const DESPEDIDA = /\b(?:obrigad\w*|valeu|tchau|abraco|retorno|falo|falamos|aviso|chamo|vejo|penso|decido|resolvo|mando|passo|to|estou|ate mais|ate logo)\b/

/** Orçamento só com a palavra que diz que é orçamento — "vi por R$ 50 no concorrente" não é. */
const ORCAMENTO_CONTEXTO = new RegExp(String.raw`\b(?:orcamento|verba|budget|gastar|investir)\b[^.!?\n]{0,30}?(?:\b\d[\d.,]*|\b${NUM}\s+mil)\b(?!\s*(?:mil\s+)?${UNIDADES}\b)`)
const ORCAMENTO_DEPOIS = /\d[\d.,]*(?:\s*mil)?(?:\s*reais)?\s+(?:pra|para|de)\s+(?:gastar|investir|orcamento)\b/

/** Trecho de `t` em volta de [ini, fim), cortado nos separadores `sep`. */
function trechoEntre(t: string, ini: number, fim: number, sep: RegExp): string {
  let a = ini
  while (a > 0 && !sep.test(t[a - 1]!)) a--
  let b = fim
  while (b < t.length && !sep.test(t[b]!)) b++
  return t.slice(a, b)
}
const FIM_DE_FRASE = /[.!?\n]/

export interface OpcoesExtracao {
  /**
   * Slot da pergunta que o agente acabou de fazer e o cliente está respondendo. Resposta a "Qual
   * quantidade?" pode vir sem verbo ("então, 80 caixas mesmo") — com a pergunta pendente a
   * intenção é dispensada; NAO_VOLUME, embalagem, "o de 5 litros" e despedida continuam barrando.
   * Quem chama decide se a pendência ainda vale (na API: autônomo e ≤ 24 h).
   */
  readonly perguntaPendente?: SlotQualificacao | null | undefined
}

/** O texto INTEIRO casa com uma das expressões? */
function casaInteiro(texto: string, res: readonly RegExp[]): boolean {
  return res.some((re) => new RegExp(`^(?:${re.source})$`).test(texto))
}

export function extrairSlotsDoCliente(texto: string, opcoes: OpcoesExtracao = {}): SlotsDoCliente {
  const r: SlotsDoCliente = {}
  if (!texto) return r
  // CNPJ primeiro, e os dígitos saem do texto antes das outras leituras (nem prazo, nem volume).
  let base = texto
  for (const m of texto.matchAll(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g)) {
    if (validarCnpj(m[0])) r.cnpj = 'informado'
    base = base.slice(0, m.index) + ' '.repeat(m[0].length) + base.slice(m.index + m[0].length)
  }
  // URL, telefone e CPF também não são volume nem prazo.
  base = base.replace(/https?:\/\/\S+|\b\d{9,}\b|\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/gi, (s) => ' '.repeat(s.length))
  const t = dobrar(base)

  // tipoCompra: "não é pra revenda" é consumo — a negação vem antes.
  if (/\b(?:nao (?:e|vou|vamos) (?:pra |para )?revend\w*|nao e (?:pra |para )?revenda|uso proprio|consumo (?:proprio|final|interno)|uso (?:interno|da empresa|na empresa)|(?:pra|para) (?:uso|consumo) (?:da|na) (?:empresa|loja))\b/.test(t)) {
    r.tipoCompra = 'consumo_final'
  } else if (/\b(?:revend\w*|(?:pra|para) revenda|sou lojista|tenho (?:uma )?loja|minha loja|meus clientes)\b/.test(t)) {
    r.tipoCompra = 'revenda'
  }

  // VOLUME — três portas, na dúvida nenhuma:
  //   1. intenção de compra antes, na mesma frase ("vou pegar 10 caixas", "me vê 30 fardos");
  //   2. a mensagem é só a quantidade, com "uns/umas" opcional, seguida no máximo de um prazo
  //      ("50 cx", "50 caixas até sexta", "uns 100 kg") — medida sozinha só com "uns/umas";
  //   3. a pergunta pendente era de volume.
  //   Em qualquer porta: NAO_VOLUME na frase, embalagem antes e "o de" antes barram.
  const reVolume = new RegExp(String.raw`\b${NUM}(?:\s+mil)?\s+(?:de\s+)?(${UNIDADES})\b`, 'g')
  for (const m of t.matchAll(reVolume)) {
    const fim = m.index + m[0].length
    const frase = trechoEntre(t, m.index, fim, FIM_DE_FRASE)
    const antes = trechoEntre(t, m.index, m.index, FIM_DE_FRASE)
    if (NAO_VOLUME.test(frase)) continue
    const perto = t.slice(Math.max(0, m.index - 20), m.index)
    if (EMBALAGEM_ANTES.test(perto) || ARTIGO_DE_ANTES.test(perto)) continue
    const prefixo = t.slice(0, m.index).trim()
    const resto = t.slice(fim).replace(/[\s.!]+$/, '').trim()
    const soQuantidade = (prefixo === '' || prefixo === 'uns' || prefixo === 'umas') &&
      (resto === '' || casaInteiro(resto, PRAZOS_COM_INTENCAO)) &&
      (!MEDIDA.test(m[1]!) || prefixo !== '' || resto !== '')
    if (!(INTENCAO_VOLUME.test(antes) || soQuantidade || opcoes.perguntaPendente === 'volume')) continue
    r.volume = base.slice(m.index, fim).trim().slice(0, 60)
    break
  }

  // PRAZO — urgência vale sozinha; o resto exige intenção na frase, ou (sem despedida/agenda):
  //   mensagem que é só o prazo com preposição ("pra sexta-feira"), prazo junto do volume desta
  //   mensagem, ou pergunta pendente de prazo.
  const soPrazo = (fraseInteira: string, trecho: string) =>
    fraseInteira.replace(/[\s.!]+$/, '').trim() === trecho && /^(?:ate|pra|para)\b/.test(trecho)
  const lerPrazo = (re: RegExp, comIntencao: boolean): string | null => {
    const m = re.exec(t)
    if (!m) return null
    const fim = m.index + m[0].length
    if (/\b(?:ha|faz|desde)\s*$/.test(t.slice(Math.max(0, m.index - 12), m.index))) return null
    if (comIntencao) {
      const frase = trechoEntre(t, m.index, fim, FIM_DE_FRASE)
      if (DESPEDIDA.test(frase)) return null
      const dispensa = soPrazo(t, m[0].trim()) || r.volume !== undefined || opcoes.perguntaPendente === 'prazo'
      if (!dispensa && !INTENCAO_PRAZO.test(frase)) return null
    }
    return base.slice(m.index, fim).trim().slice(0, 60) || null
  }
  const prazo = PRAZOS_DIRETOS.map((re) => lerPrazo(re, false)).find(Boolean)
    ?? PRAZOS_COM_INTENCAO.map((re) => lerPrazo(re, true)).find(Boolean)
  if (prazo) r.prazo = prazo

  if (ORCAMENTO_CONTEXTO.test(t) || ORCAMENTO_DEPOIS.test(t)) r.orcamento = 'informado'
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
