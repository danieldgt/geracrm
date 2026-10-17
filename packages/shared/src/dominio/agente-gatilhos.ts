/**
 * GATILHOS DE ENTRADA, IDENTIDADE E PRIVACIDADE (raia P4, ADR-029 §2).
 *
 * Regras PURAS sobre o texto do cliente, decididas ANTES do modelo e sem gastar
 * token: opt-out, pedido de humano, reclamação/Procon/jurídico, "é robô?" e
 * gatilhos extras de compliance. Mais os textos fixos que o agente manda sem
 * modelo (abertura, resposta ao "é robô?", confirmação de opt-out, aviso de
 * transferência, pedido de texto quando o áudio não foi transcrito).
 *
 * ⚠️ "cancelar pedido" NÃO é opt-out: no B2B "cancelar" quase sempre fala do
 *    PEDIDO. Por isso "cancelar" sozinho também ficou fora (a AM aceita; aqui
 *    bloquearia o número de quem só queria desfazer a compra).
 * ⚠️ Texto fixo nunca promete prazo ("em 5 minutos", "já já") nem nega ser IA.
 * TypeScript puro: consumido pela API e pelo console.
 */

export const GATILHOS_ENTRADA = ['opt_out', 'pedido_humano', 'reclamacao', 'pergunta_robo', 'extra'] as const
export type GatilhoEntrada = (typeof GATILHOS_ENTRADA)[number]

/** Minúsculas, sem acento, espaços colapsados — a forma em que as regras casam. */
export function normalizarTextoGatilho(texto: string): string {
  return texto.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

// ── opt-out ─────────────────────────────────────────────────────────────────

const OPT_OUT_RES: readonly RegExp[] = [
  // Mensagem que é SÓ a palavra (com pontuação de exclamação, nunca pergunta).
  /^(pare|para|parar|sair|stop|chega|descadastrar)\s*[.!]*$/,
  /nao (quero|desejo) (mais )?receber/,
  /nao (quero|desejo) mais (mensage|contato|que (voce|vcs?|voces) (me )?(mand|envi|cham))/,
  /(para|pare|parem) de me (mandar|enviar|chamar|mandarem|enviarem)/,
  /(para|pare|parem) de mandar mensage/,
  /me (tira|tire|tirem|remova|remove|removam|exclua|excluam) (da|dessa|desta|de) (sua |vossa )?lista/,
  /descadastr/,
  /(apag|exclu|delet|remov)\w* (os |todos os )?meus dados/,
]
const EXCLUSAO_RES: readonly RegExp[] = [/(apag|exclu|delet|remov)\w* (os |todos os )?meus dados/, /\blgpd\b/]
/** Fala do PEDIDO (ou de item, compra, nota): nunca é opt-out, mesmo com "cancelar"/"parar". */
const SOBRE_O_PEDIDO = /\b(cancel\w*|desist\w*|par\w*) (o |a |esse |essa |este |esta |meu |minha |do |da )?(pedido|compra|orcamento|item|itens|nota|entrega|boleto|cobranca)\b/

export type MotivoOptOut = 'opt_out' | 'lgpd_exclusao'

/**
 * O cliente pediu para não receber mais mensagens? `lgpd_exclusao` quando
 * também pediu para apagar os dados (o time conclui a exclusão — R10d).
 */
export function detectarOptOut(texto: string): MotivoOptOut | null {
  const t = normalizarTextoGatilho(texto)
  if (!t || SOBRE_O_PEDIDO.test(t)) return null
  if (!OPT_OUT_RES.some((r) => r.test(t))) return null
  return EXCLUSAO_RES.some((r) => r.test(t)) ? 'lgpd_exclusao' : 'opt_out'
}

// ── pedido de humano, reclamação ────────────────────────────────────────────

const HUMANO_RES: readonly RegExp[] = [
  /(falar|conversar) com (um |uma |o |a |algum |alguma )?(humano|pessoa|atendente|vendedor|vendedora|consultor|consultora|gerente|representante|alguem)/,
  /\b(quero|preciso de|prefiro) (um |uma )?(humano|atendente|pessoa (real|de verdade))\b/,
  /\bme liga\b/,
  /\bpode me ligar\b/,
  /\bme (passa|transfere) (pra|para|pro) (um |uma |o |a )?(atendente|vendedor|vendedora|pessoa|humano|gerente)/,
]

/** "quero falar com um atendente", "me liga", "me passa pro vendedor". */
export function detectarPedidoHumano(texto: string): boolean {
  const t = normalizarTextoGatilho(texto)
  return HUMANO_RES.some((r) => r.test(t))
}

const RECLAMACAO_RES: readonly RegExp[] = [
  /procon/, /reclame ?aqui/, /advogad/, /\bjuridic/, /\bprocess(ar|o judicial)\b/, /vou processar/,
  /\breclamacao\b/, /quero reclamar/, /\bdenuncia(r)?\b/, /\bna justica\b/, /\bliminar\b/,
]

/** Reclamação formal, Procon, jurídico — sempre com uma pessoa. */
export function detectarReclamacao(texto: string): boolean {
  const t = normalizarTextoGatilho(texto)
  return RECLAMACAO_RES.some((r) => r.test(t))
}

// ── "é robô?" ───────────────────────────────────────────────────────────────

const ROBO_RES: readonly RegExp[] = [
  /(?<![a-z])(robo|bot|chatbot|maquina|inteligencia artificial)(?![a-z])[^?]*\?/,
  /(?<![a-z])(e|eh|sera que e|voce e|vc e) (um |uma )?(robo|bot|ia|chatbot|maquina)(?![a-z])/,
  /falando com (um |uma )?(robo|bot|maquina|pessoa de verdade|humano|gente de verdade)/,
  /(voce|vc) e (uma )?(pessoa|humano|humana|gente) (de verdade|real)?\s*\?/,
]

export function detectarPerguntaRobo(texto: string): boolean {
  const t = normalizarTextoGatilho(texto)
  return ROBO_RES.some((r) => r.test(t))
}

// ── gatilhos extras (compliance do número, P2) ──────────────────────────────

/**
 * Gatilhos de transferência EXTRAS configurados pelo cliente (literais, sem
 * acento/caixa, palavra inteira). Só ACRESCENTAM aos de base. Devolve o termo
 * que casou ou null.
 */
export function gatilhoExtra(texto: string, lista: readonly string[] | undefined): string | null {
  if (!lista?.length) return null
  const t = ` ${normalizarTextoGatilho(texto).replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ')} `
  for (const bruto of lista) {
    const termo = normalizarTextoGatilho(String(bruto)).replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim()
    if (termo && t.includes(` ${termo} `)) return String(bruto).trim()
  }
  return null
}

/**
 * O primeiro gatilho que o texto aciona, na ordem de precedência:
 * opt-out → reclamação → pedido de humano → extra → "é robô?".
 */
export function detectarGatilhoDeEntrada(texto: string, extras?: readonly string[]): GatilhoEntrada | null {
  if (detectarOptOut(texto)) return 'opt_out'
  if (detectarReclamacao(texto)) return 'reclamacao'
  if (detectarPedidoHumano(texto)) return 'pedido_humano'
  if (gatilhoExtra(texto, extras)) return 'extra'
  if (detectarPerguntaRobo(texto)) return 'pergunta_robo'
  return null
}

// ── textos fixos ────────────────────────────────────────────────────────────

export interface IdentidadeAssistente {
  /** Nome da persona (`agente_config.persona.nome`). */
  readonly assistenteNome: string
  /** Nome da loja como o cliente a conhece; vazio = "da loja". */
  readonly loja?: string | undefined
}

function daLoja(loja: string | undefined): string {
  const l = loja?.trim()
  return l ? `da ${l}` : 'da loja'
}

/** Frase padrão de registro da conversa — é o que conta como "aviso exibido" sem URL. */
export const FRASE_REGISTRO_CONVERSA = 'Esta conversa fica registrada para te atender melhor.'

/** O aviso de privacidade como aparece no fim da abertura (texto do tenant + link). */
export function textoAvisoPrivacidade(o: { textoPadrao?: string | null | undefined; url?: string | null | undefined } = {}): string {
  const base = o.textoPadrao?.trim() || FRASE_REGISTRO_CONVERSA
  const url = o.url?.trim()
  return url && !base.includes(url) ? `${base} Aviso de privacidade: ${url}` : base
}

/**
 * A mensagem exibida contém o aviso de privacidade? Com URL configurada, o link
 * precisa estar lá; sem URL, o texto padrão do tenant (ou a frase de registro).
 */
export function contemAvisoPrivacidade(
  texto: string, o: { textoPadrao?: string | null | undefined; url?: string | null | undefined } = {},
): boolean {
  const url = o.url?.trim()
  if (url) return texto.includes(url)
  const t = normalizarTextoGatilho(texto)
  const padrao = o.textoPadrao?.trim()
  if (padrao && t.includes(normalizarTextoGatilho(padrao))) return true
  return /aviso de privacidade|conversa fica registrada/.test(t)
}

/**
 * Primeira mensagem do agente na conversa: diz que é uma ASSISTENTE VIRTUAL
 * (IA), de qual loja, que uma pessoa assume quando o cliente quiser, e exibe o
 * aviso de privacidade. Exigência da Meta e do ADR-028 — não é opção da tela.
 */
export function textoAbertura(o: IdentidadeAssistente & {
  clienteNome?: string | null | undefined
  privacidade?: { textoPadrao?: string | null | undefined; url?: string | null | undefined } | undefined
}): string {
  const primeiro = o.clienteNome?.trim().split(/\s+/)[0]
  const nome = o.assistenteNome.trim() || 'Assistente'
  return `Oi${primeiro ? `, ${primeiro}` : ''}! Sou ${nome}, assistente virtual ${daLoja(o.loja)} (uma inteligência artificial). `
    + 'Posso consultar produtos e montar seu pedido; quando preferir, alguém da equipe assume por aqui mesmo. '
    + textoAvisoPrivacidade(o.privacidade)
}

/** Resposta fixa ao 1º "é robô?": confirma que é IA (nunca nega) e oferece a pessoa. */
export function textoRobo(o: IdentidadeAssistente): string {
  const nome = o.assistenteNome.trim() || 'Assistente'
  return `Sou ${nome}, assistente virtual ${daLoja(o.loja)}: uma inteligência artificial, e esta conversa fica registrada. `
    + 'Se preferir, chamo uma pessoa da equipe para continuar com você aqui mesmo. Quer que eu chame?'
}

/**
 * Confirmação do opt-out. ⚠️ Sai ANTES do bloqueio — depois dele o gateway
 * recusa qualquer envio, inclusive este. Não convida a "escrever de novo":
 * o número fica bloqueado até alguém da loja desfazer.
 */
export function textoOptOut(o: { clienteNome?: string | null | undefined; exclusao?: boolean | undefined } = {}): string {
  const primeiro = o.clienteNome?.trim().split(/\s+/)[0]
  const n = primeiro ? `, ${primeiro}` : ''
  return o.exclusao
    ? `Certo${n}. Não vamos mais te enviar mensagens por aqui, e registrei seu pedido de exclusão dos dados para a equipe concluir.`
    : `Certo${n}. Não vamos mais te enviar mensagens por aqui.`
}

/** Aviso ao cliente quando um gatilho transfere para uma pessoa. Sem prazo. */
export function textoHandoffGatilho(o: { foraDoExpediente: boolean }): string {
  return o.foraDoExpediente
    ? 'Certo! Já registrei aqui, e uma pessoa da equipe continua com você no próximo horário de atendimento, neste mesmo número.'
    : 'Certo! Já chamei uma pessoa da equipe para continuar com você aqui mesmo, neste número.'
}

/** 1º áudio que não deu para transcrever: pede texto (o 2º vai para uma pessoa). */
export const TEXTO_PEDE_TEXTO_AUDIO =
  'Não consegui ouvir seu áudio por aqui. Consegue me mandar por escrito?'

/** Instrução ao modelo no turno em que a abertura já saiu (não se reapresentar). */
export const INSTRUCAO_ABERTURA_ENVIADA =
  'A apresentação como assistente virtual e o aviso de privacidade JÁ foram enviados nesta conversa. Não se reapresente; responda direto ao que o cliente disse.'
