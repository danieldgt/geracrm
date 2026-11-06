/**
 * Regras puras do visualizador de imagem (lightbox). Sem Angular: testável sem DOM.
 */
export interface ImagemVisualizavel {
  readonly id: string
  readonly src: string
  readonly legenda?: string
}

/**
 * Índice seguinte ao andar `passo` casas (-1 = anterior, +1 = próxima).
 *
 * ⚠️ Não dá a volta: na última imagem, "próxima" fica onde está. Dar a volta faria a
 * vendedora achar que a conversa tem só as imagens que já viu — a borda é informação.
 */
export function andarImagem(atual: number, total: number, passo: number): number {
  if (total <= 0) return 0
  return Math.min(total - 1, Math.max(0, atual + passo))
}

/** "3 de 7" — só quando há mais de uma imagem; com uma, o contador é ruído. */
export function contadorImagem(indice: number, total: number): string {
  return total > 1 ? `${indice + 1} de ${total}` : ''
}

/** Posição da imagem pelo id; -1 se não estiver na lista (ex.: a mensagem foi apagada no meio). */
export function indiceDaImagem(imagens: readonly ImagemVisualizavel[], id: string): number {
  return imagens.findIndex((i) => i.id === id)
}

/** Nome do arquivo para "Baixar": data URL não tem nome, então nasce um pela extensão do tipo. */
export function nomeParaBaixar(src: string, base = 'imagem'): string {
  const tipo = /^data:image\/([a-z0-9.+-]+)[;,]/i.exec(src)?.[1]?.toLowerCase()
  if (tipo) return `${base}.${tipo === 'jpeg' ? 'jpg' : tipo.replace('svg+xml', 'svg')}`
  const ultimo = src.split(/[?#]/)[0]?.split('/').pop() ?? ''
  return /\.[a-z0-9]{2,5}$/i.test(ultimo) ? ultimo : `${base}.jpg`
}

export interface Medida { readonly largura: number; readonly altura: number }

/** Quanto uma imagem pequena pode crescer para caber na tela — além disso, só borra. */
export const AMPLIACAO_MAXIMA = 3

/**
 * Tamanho em que a imagem cabe INTEIRA na área, mantendo a proporção.
 *
 * ⚠️ Amplia a imagem pequena (é o pedido: "ver maior"), mas até `AMPLIACAO_MAXIMA` —
 * uma figurinha de 120 px esticada para 1.000 px vira borrão. Medida zerada (imagem
 * ainda carregando, área sem layout) devolve null: o CSS cuida até a medida chegar.
 */
export function encaixar(natural: Medida, area: Medida): Medida | null {
  if (natural.largura <= 0 || natural.altura <= 0 || area.largura <= 0 || area.altura <= 0) return null
  const escala = Math.min(area.largura / natural.largura, area.altura / natural.altura, AMPLIACAO_MAXIMA)
  return { largura: Math.round(natural.largura * escala), altura: Math.round(natural.altura * escala) }
}

/** A imagem é maior que a área? Só então "Tamanho real" mostra algo que o encaixe esconde. */
export function cabeReduzida(natural: Medida, area: Medida): boolean {
  return natural.largura > area.largura || natural.altura > area.altura
}
