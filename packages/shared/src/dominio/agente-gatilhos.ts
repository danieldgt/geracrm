/**
 * GATILHOS DE ENTRADA, IDENTIDADE E PRIVACIDADE (raia P4, ADR-029 §2).
 *
 * Regras PURAS sobre o texto do cliente, decididas ANTES do modelo e sem gastar
 * token: opt-out, pedido de humano, ameaça formal (Procon/justiça), "é robô?" e
 * gatilhos extras de compliance. Mais os textos fixos que o agente manda sem
 * modelo (abertura, resposta ao "é robô?", confirmação de opt-out, aviso de
 * transferência, pedido de texto quando o áudio não foi transcrito).
 *
 * ⚠️ PRINCÍPIO: falso opt-out é o erro MAIS CARO — bloqueia o número de quem
 *    só reclamava do boleto e ninguém percebe. Por isso as regras são ESTREITAS:
 *    o automático só vale para a palavra sozinha (pare, sair, stop,
 *    descadastrar) ou para o verbo de parar com objeto de MENSAGEM (mensagens,
 *    contato, promoção, "isso", "nada") ou no fim da frase. Qualquer menção a
 *    mercadoria/pagamento (boleto, pedido, caixa, nota, entrega…) desliga a
 *    regra. O que sobra ambíguo vira `possivel_opt_out` — vai para uma PESSOA,
 *    nunca para o bloqueio.
 * ⚠️ "cancelar pedido" NÃO é opt-out; nem "cancelar" ou "chega" sozinhos
 *    (no B2B são resposta a "mais algum item?").
 * ⚠️ Texto fixo nunca promete prazo ("em 5 minutos", "já já") nem nega ser IA.
 * TypeScript puro: consumido pela API e pelo console.
 */

export const GATILHOS_ENTRADA = ['opt_out', 'possivel_opt_out', 'pedido_humano', 'reclamacao', 'pergunta_robo', 'extra'] as const
export type GatilhoEntrada = (typeof GATILHOS_ENTRADA)[number]

/** Minúsculas, sem acento, espaços colapsados — a forma em que as regras casam. */
export function normalizarTextoGatilho(texto: string): string {
  return texto.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Normalizado e sem pontuação (só letras, dígitos e espaço). */
function palavras(texto: string): string {
  return normalizarTextoGatilho(texto).replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim()
}

// ── opt-out ─────────────────────────────────────────────────────────────────

/** A mensagem inteira é só a palavra. "chega", "para" e "cancelar" ficam FORA. */
const OPT_OUT_PALAVRA_UNICA = /^(pare|sair|stop|descadastrar|descadastra|descadastre)( (por favor|pfv|pf|obrigad[oa]|obg|valeu|grat[oa]))*$/
/**
 * Palavra solta que PODE ser "pare" ou resposta a "mais algum item?" ("chega",
 * "para"): vai para uma pessoa (`possivel_opt_out`), nunca para o bloqueio.
 */
const PALAVRA_AMBIGUA = /^(para|parar|chega|chega disso)( (por favor|pfv|obrigad[oa]))*$/

/** Verbos de "parar de receber". O que vem DEPOIS decide se é opt-out. */
const VERBO_PARAR = new RegExp([
  String.raw`nao (quero|desejo|quer) (mais )?receber`,
  // Formas explícitas com o objeto JÁ no padrão (o resto ainda é conferido).
  String.raw`nao (quero|desejo) mais (mensagem|mensagens|msg|msgs|contato|contatos)\b`,
  String.raw`chega de (mensagem|mensagens|msg|msgs|propaganda|propagandas|promocao|promocoes|oferta|ofertas)\b`,
  String.raw`(quero |gostaria de )?(parar de|nao) receber (mais )?(mensagem|mensagens|msg|msgs|isso|nada)\b`,
  String.raw`nao (me )?(manda|chama|mandem|chamem) mais\b`,
  String.raw`(quero )?sair da (sua |tua )?lista\b`,
  String.raw`nao (quero|desejo) mais que (voce|vc|voces|vcs) (me )?(mandem|enviem|chamem|mande|envie|chame)\b`,
  String.raw`(parem|parar|para|pare) de (me )?(mandarem|enviarem|mandar|enviar|chamar)\b`,
  String.raw`nao (me )?(mandem|enviem|mande|envie) mais\b`,
  String.raw`me (tira|tire|tirem|remova|remove|removam|exclua|excluam) (da|dessa|desta|de|do) (sua |vossa )?(lista|cadastro)`,
  String.raw`(quero |pode |podem )?(me )?descadastr\w*`,
  String.raw`(apag|exclu|delet|remov)\w* (os |todos os )?meus dados( pessoais)?`,
].join('|'), 'g')

/**
 * Mercadoria, pagamento, logística: em QUALQUER ponto da frase, a regra de
 * opt-out desliga — "não quero receber boleto", "pare de mandar produto
 * vencido", "me tira da lista de espera", "apaga meus dados do cartão".
 */
const SOBRE_O_NEGOCIO = /\b(pedidos?|compras?|boletos?|pix|notas?|nf|nfe|caixas?|mercadorias?|produtos?|entregas?|marcas?|cartao|cartoes|bancari\w*|e ?mail|email|financeiro|lojas?|itens|item|encomendas?|faturas?|cobrancas?|errad[oa]s?|vencid[oa]s?|atrasos?|atrasad[oa]s?|espera|presentes?|precos?|orcamentos?|fretes?|estoques?|tamanhos?|kits?|pacotes?|duplicatas?|cancel\w*)\b/

/** Objeto do verbo que é a própria MENSAGEM (ou o canal). */
const OBJETO_MENSAGEM = /^(mensagem|mensagens|msgs?|contatos?|promocao|promocoes|ofertas?|propagandas?|anuncios?|spam|isso|nada|whats|whatsapp|zap|novidades?|comunicados?)\b/
/** Palavras de ligação entre o verbo e o objeto ("mais essas", "de vocês"). */
const LIGACAO = /^(mais|essas?|esses?|estas?|estes?|suas?|seus?|de|da|do|das|dos|as|os|a|o|me|nenhuma|nenhum|qualquer|tipo|por|aqui|pelo|pela|no|na|voces|vcs|voce|vc|nesse|neste|numero)\b\s*/
/** Fecho que não muda o sentido ("por favor", "obrigado"). */
const FECHO = /^(por favor|pfv|pf|obrigad[oa]|obg|ok|ta|valeu|grato|grata)\b/

function terminaOuFalaDeMensagem(resto: string): boolean {
  let r = resto.trim()
  for (let i = 0; i < 8 && LIGACAO.test(r); i += 1) r = r.replace(LIGACAO, '').trim()
  return r === '' || OBJETO_MENSAGEM.test(r) || FECHO.test(r)
}

const EXCLUSAO_DADOS = /(apag|exclu|delet|remov)\w* (os |todos os )?meus dados|\blgpd\b/

export type MotivoOptOut = 'opt_out' | 'lgpd_exclusao' | 'possivel_opt_out'

/**
 * O cliente pediu para não receber mais mensagens?
 *   - `opt_out` / `lgpd_exclusao` (também pediu para apagar os dados): CLARO.
 *   - `possivel_opt_out`: verbo de parar com objeto que não é mensagem nem
 *     mercadoria ("não quero mais receber essas coisas") — vai para uma pessoa.
 *     Também: verbo de parar junto de mercadoria/pagamento ("não quero
 *     receber boleto") e as palavras soltas "para", "parar", "chega".
 *   - null: nenhum verbo de parar.
 */
export function detectarOptOut(texto: string): MotivoOptOut | null {
  const t = palavras(texto)
  if (!t) return null
  if (OPT_OUT_PALAVRA_UNICA.test(t)) return 'opt_out'
  if (PALAVRA_AMBIGUA.test(t)) return 'possivel_opt_out'
  const casos = [...t.matchAll(VERBO_PARAR)]
  if (casos.length === 0) return null
  // ⚠️ Verbo de parar + mercadoria/pagamento: pode ser "não quero receber
  //    boleto" OU "não quero mais receber promoção de produtos". Não bloqueia
  //    e não deixa o modelo seguir vendendo: uma pessoa decide.
  if (SOBRE_O_NEGOCIO.test(t)) return 'possivel_opt_out'
  const claro = casos.some((m) => terminaOuFalaDeMensagem(t.slice((m.index ?? 0) + m[0].length)))
  if (!claro) return 'possivel_opt_out'
  return EXCLUSAO_DADOS.test(t) ? 'lgpd_exclusao' : 'opt_out'
}

// ── pedido de humano ────────────────────────────────────────────────────────

const PAPEL_HUMANO = String.raw`(humano|humana|pessoa|atendente|vendedor|vendedora|consultor|consultora|gerente|representante|alguem)`
/** Desejo + falar com alguém. "vou conversar com o vendedor depois" não é pedido. */
const FALAR_COM = new RegExp(String.raw`\b(quero|queria|preciso|precisava|gostaria de|posso|poderia|pode|prefiro|da pra|tem como) (falar|conversar) com (um |uma |o |a |algum |alguma |seu |sua )?${PAPEL_HUMANO}\b`, 'g')
/** O papel é DELE ("o gerente da minha loja") ou é para depois — não é pedido de atendimento agora. */
const PAPEL_DELE_OU_DEPOIS = /^(da|do|de) (minha|meu|nossa|nosso)\b|^(antes|depois|amanha|mais tarde|outra hora|semana que vem)\b/
const HUMANO_RES: readonly RegExp[] = [
  /\b(quero|preciso de|prefiro) (um |uma )?(humano|atendente|pessoa (real|de verdade))( agora| por favor| pfv)?$/,
  // "me liga" só como pedido: a mensagem inteira, ou "pode me ligar".
  /^(me liga|me ligue|me liga ai|liga pra mim)( agora| por favor| pfv)?$/,
  /\b(pode|poderia|podem|consegue|da pra) me ligar\b/,
  /\bme (passa|transfere|transfira|passe) (pra|para|pro|com) (um |uma |o |a )?(atendente|vendedor|vendedora|pessoa|humano|gerente|consultor|consultora)\b/,
  /\batendente humano\b/,
]

/** "quero falar com um atendente", "me liga", "me passa pro vendedor". */
export function detectarPedidoHumano(texto: string): boolean {
  const t = palavras(texto)
  if (HUMANO_RES.some((r) => r.test(t))) return true
  return [...t.matchAll(FALAR_COM)].some((m) => !PAPEL_DELE_OU_DEPOIS.test(t.slice((m.index ?? 0) + m[0].length).trim()))
}

// ── ameaça formal (Procon, justiça) ─────────────────────────────────────────

/**
 * Só a forma de AMEAÇA: "pode processar o pedido", "o jurídico precisa da nota"
 * e "meu advogado pediu a nota" são rotina e seguem com o agente.
 */
const RECLAMACAO_RES: readonly RegExp[] = [
  /\bprocon\b/,
  /\breclame ?aqui\b/,
  /\b(vou|vamos|irei) (te |lhe )?processar\b/,
  /\bprocessar (voces|vcs|voce|vc|a loja|a empresa|essa loja|essa empresa)\b/,
  /\bprocesso judicial\b/,
  /\bna justica\b/,
  /\b(vou|vamos|irei) (acionar|chamar) (o |meu |nosso |um )?(advogad\w*|juridico)\b/,
  /\b(meu|nosso) advogad\w* (vai|vao) (entrar|acionar|processar|te procurar)\b/,
]

/** Ameaça formal — sempre com uma pessoa. */
export function detectarReclamacao(texto: string): boolean {
  const t = palavras(texto)
  return RECLAMACAO_RES.some((r) => r.test(t))
}

// ── "é robô?" ───────────────────────────────────────────────────────────────

const ALVO_ROBO = String.raw`(robo|bot|chatbot|ia|maquina|inteligencia artificial|robozinho)`
/**
 * Exige cópula com pronome ("você é robô", "isso é bot", "aqui é IA"),
 * "falando com robô" ou a pergunta/palavra sozinha. "A máquina de cartão
 * quebrou?" e "o robô de limpeza chegou?" ficam de fora.
 */
const ROBO_RES: readonly RegExp[] = [
  new RegExp(String.raw`\b(voce|vc|ce|tu|isso|aqui|isto|quem fala) (e|eh|seria) (mesmo )?(um |uma )?${ALVO_ROBO}\b`),
  new RegExp(String.raw`^(sera que )?(e|eh) (um |uma )?${ALVO_ROBO}( mesmo| ne| ou (humano|pessoa|gente))?$`),
  new RegExp(String.raw`^${ALVO_ROBO}( mesmo)?$`),
  /\b(falando|conversando) com (um |uma )?(robo|bot|chatbot|maquina|ia|pessoa de verdade|humano|gente de verdade)\b/,
  /\b(voce|vc) e (uma )?(pessoa|humano|humana|gente) (de verdade|real)\b/,
]

/** "é robô?" — só a pergunta à ASSISTENTE, nunca uma máquina do cliente. */
export function detectarPerguntaRobo(texto: string): boolean {
  const t = palavras(texto)
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
  const t = ` ${palavras(texto)} `
  for (const bruto of lista) {
    const termo = palavras(String(bruto))
    if (termo && t.includes(` ${termo} `)) return String(bruto).trim()
  }
  return null
}

/**
 * O primeiro gatilho que o texto aciona, na ordem de precedência:
 * opt-out → possível opt-out → ameaça formal → pedido de humano → extra → "é robô?".
 */
export function detectarGatilhoDeEntrada(texto: string, extras?: readonly string[]): GatilhoEntrada | null {
  const o = detectarOptOut(texto)
  if (o === 'possivel_opt_out') return 'possivel_opt_out'
  if (o) return 'opt_out'
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

/** Instrução ao modelo no turno em que a abertura vai antes da resposta dele (não se reapresentar). */
export const INSTRUCAO_ABERTURA_ENVIADA =
  'O sistema envia, ANTES da sua resposta, a apresentação como assistente virtual e o aviso de privacidade. Não se reapresente; responda direto ao que o cliente disse.'

/** Aviso ao vendedor (assistido) quando o cliente pediu opt-out: o bloqueio é decisão dele. */
export const AVISO_CONFIRMAR_OPT_OUT =
  'Cliente pediu opt-out: confirme com ele e bloqueie o número em Opt-out / Bloqueios.'

/** Resumo da transferência quando a frase PARECE opt-out mas não é clara. */
export const RESUMO_POSSIVEL_OPT_OUT =
  'Possível pedido para não receber mais mensagens (frase ambígua). Confirme com o cliente; se for o caso, bloqueie em Opt-out / Bloqueios. Nada foi bloqueado.'
