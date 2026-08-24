/**
 * O CÓDIGO DE ORIGEM — como um lead que veio do anúncio se identifica quando
 * escreve no WhatsApp.
 *
 * Sem Click-to-WhatsApp (AMK-012), não há `ctwa_clid` chegando no protocolo. A
 * landing page gera um código curto, guarda `gclid`/UTM contra ele e o injeta na
 * mensagem pronta do link `wa.me`. Quando a mensagem chega, o código liga a
 * conversa ao anúncio. É o nosso `ctwa_clid`, feito à mão (AQ-44/45).
 *
 * ⚠️ **O código é editável pelo lead.** Ele pode apagar o texto pronto antes de
 * enviar. Todo este módulo assume a perda: extrair é tolerante, e a ausência é um
 * resultado normal — origem PARCIAL —, nunca uma exceção.
 */

/**
 * Alfabeto SEM caracteres ambíguos: fora `O`/`0`, `I`/`1`/`L`. O código aparece
 * numa conversa e pode ser lido em voz alta ou redigitado por uma pessoa —
 * `A7K2Q` e `A7KZQ` não podem depender da fonte da tela para se distinguir.
 *
 * ⚠️ É subconjunto de `[A-Z0-9]`, o formato aceito pelo CHECK da migration 0059.
 */
const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

/** Comprimento padrão. 31^6 ≈ 887 milhões de combinações por tenant. */
export const TAMANHO_CODIGO = 6

/**
 * Gera o código a partir de bytes aleatórios — puro, para poder ser testado.
 * Quem chama fornece a entropia (`randomBytes` no servidor).
 *
 * ⚠️ O módulo enviesa levemente as primeiras letras do alfabeto (256 % 31 ≠ 0).
 * Irrelevante aqui: o código é marcador de sessão, não segredo. Se um dia
 * precisar ser imprevisível, o viés passa a importar e a geração muda.
 */
export function codigoDeBytes(bytes: Uint8Array): string {
  if (bytes.length < TAMANHO_CODIGO) {
    throw new TypeError(`precisa de ao menos ${TAMANHO_CODIGO} bytes`)
  }
  let codigo = ''
  for (let i = 0; i < TAMANHO_CODIGO; i++) codigo += ALFABETO[bytes[i]! % ALFABETO.length]
  return codigo
}

/** O código está no formato que geramos? (Não diz se existe — isso é do banco.) */
export function codigoValido(codigo: string): boolean {
  if (codigo.length !== TAMANHO_CODIGO) return false
  return [...codigo].every((c) => ALFABETO.includes(c))
}

/**
 * Monta o texto pronto do link `wa.me`.
 *
 * ⚠️ O marcador fica no FIM e entre colchetes: o lead lê a frase dele primeiro, e
 * quem apaga costuma apagar a linha inteira — o que produz ausência limpa, não
 * código corrompido pela metade.
 */
export function montarTextoWaMe(textoBase: string, codigo: string): string {
  return `${textoBase.trim()} [ref: ${codigo}]`
}

/**
 * Procura o código na PRIMEIRA mensagem do lead.
 *
 * Tolerante de propósito, porque a mensagem passou por um humano e por um
 * teclado de celular:
 * - aceita em **qualquer posição**, não só no fim;
 * - aceita com ou sem o prefixo `ref:`;
 * - aceita minúsculas (o autocorretor do celular rebaixa maiúsculas);
 * - ignora acentos e pontuação ao redor.
 *
 * ⚠️ Devolve `null` quando não acha — e isso é um caminho ESPERADO, não um erro.
 * A taxa de `null` é métrica de saúde da atribuição (AQ-45).
 */
export function extrairCodigoOrigem(mensagem: string): string | null {
  // 1) Forma canônica `[ref: XXXXXX]` — a que nós mesmos geramos.
  const canonico = /\[\s*ref:\s*([a-zA-Z0-9]{6})\s*\]/.exec(mensagem)
  if (canonico && codigoValido(canonico[1]!.toUpperCase())) return canonico[1]!.toUpperCase()

  // 2) `ref: XXXXXX` sem colchetes — sobrevive a quem apagou só a pontuação.
  const semColchete = /\bref:?\s*([a-zA-Z0-9]{6})\b/.exec(mensagem)
  if (semColchete && codigoValido(semColchete[1]!.toUpperCase())) return semColchete[1]!.toUpperCase()

  // 3) Última tentativa: qualquer palavra de 6 caracteres do nosso alfabeto.
  //    ⚠️ Só vale se houver EXATAMENTE uma candidata. Duas significam ambiguidade,
  //    e chutar entre elas atribuiria a venda ao anúncio errado — pior que não
  //    atribuir, porque o número fica plausível e ninguém desconfia.
  const candidatas = new Set<string>()
  for (const bruto of mensagem.split(/[^a-zA-Z0-9]+/)) {
    const c = bruto.toUpperCase()
    if (codigoValido(c)) candidatas.add(c)
  }
  return candidatas.size === 1 ? [...candidatas][0]! : null
}
