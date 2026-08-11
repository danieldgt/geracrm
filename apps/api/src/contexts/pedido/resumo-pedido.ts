/**
 * Resumo do pedido em texto para mandar ao cliente pelo WhatsApp. Puro e
 * testável; formatação amigável (negrito do WhatsApp, quantidade sem casas
 * quando inteira). É a MENSAGEM PADRÃO de confirmação do pedido montado no chat.
 */
export interface ItemResumo {
  readonly descricao: string
  /** Variação escolhida (cor · tamanho …), do grade_snapshot. Opcional. */
  readonly variacao?: string | null
  readonly quantidade: number
  readonly valorUnitarioCentavos: number
}
export interface ContextoResumo {
  readonly contatoNome?: string | null
  readonly formaPagamento?: string | null
  readonly observacao?: string | null
  /** Código curto do pedido (para situar o registro). Ex.: 'A1B2C3'. */
  readonly pedidoCodigo?: string | null
  /** Código curto do chat/conversa (para situar a conversa). Ex.: '4D5E6F'. */
  readonly chatCodigo?: string | null
}

/** Código curto e legível a partir de um UUID — os 6 últimos hex, maiúsculos. */
export function codigoReferencia(id: string): string {
  return id.replace(/-/g, '').slice(-6).toUpperCase()
}

function reais(centavos: number): string {
  return (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}
function qtd(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toLocaleString('pt-BR', { maximumFractionDigits: 3 })
}
/** Primeiro nome, para a saudação. */
function primeiroNome(nome?: string | null): string {
  const p = (nome ?? '').trim().split(/\s+/)[0]
  return p ? p : ''
}

export function resumoPedidoTexto(
  itens: readonly ItemResumo[],
  totalCentavos: number,
  ctx: ContextoResumo = {},
): string {
  const linhas: string[] = []
  const saud = primeiroNome(ctx.contatoNome)
  linhas.push(saud ? `Olá, ${saud}! Segue o resumo do seu pedido 👇` : '*Resumo do seu pedido*')
  linhas.push('')
  for (const i of itens) {
    // Referência escolhida com cor/tamanho + preço unitário + subtotal.
    const nome = i.variacao ? `${i.descricao} (${i.variacao})` : i.descricao
    const unit = reais(i.valorUnitarioCentavos)
    linhas.push(`• ${qtd(i.quantidade)}× ${nome} — ${unit} = ${reais(i.quantidade * i.valorUnitarioCentavos)}`)
  }
  linhas.push('')
  linhas.push(`*Total: ${reais(totalCentavos)}*`)
  if (ctx.formaPagamento && ctx.formaPagamento.trim()) linhas.push(`Pagamento: ${ctx.formaPagamento.trim()}`)
  if (ctx.observacao && ctx.observacao.trim()) linhas.push(`Obs.: ${ctx.observacao.trim()}`)
  linhas.push('')
  linhas.push('Podemos confirmar? Responda *SIM* que já finalizo. 🙂')
  // Referência do registro (pedido · chat) para situar a conversa e organizar o
  // histórico. Discreto, no rodapé, em itálico do WhatsApp.
  const refs: string[] = []
  if (ctx.pedidoCodigo && ctx.pedidoCodigo.trim()) refs.push(`Pedido #${ctx.pedidoCodigo.trim()}`)
  if (ctx.chatCodigo && ctx.chatCodigo.trim()) refs.push(`Chat #${ctx.chatCodigo.trim()}`)
  if (refs.length) { linhas.push(''); linhas.push(`_${refs.join(' · ')}_`) }
  return linhas.join('\n')
}
