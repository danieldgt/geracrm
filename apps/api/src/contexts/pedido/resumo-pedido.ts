/**
 * Resumo do pedido em texto para mandar ao cliente pelo WhatsApp. Puro e
 * testável; formatação amigável (negrito do WhatsApp, quantidade sem casas
 * quando inteira). É a MENSAGEM PADRÃO de confirmação do pedido montado no chat.
 */
export interface ItemResumo {
  readonly descricao: string
  readonly quantidade: number
  readonly valorUnitarioCentavos: number
}
export interface ContextoResumo {
  readonly contatoNome?: string | null
  readonly formaPagamento?: string | null
  readonly observacao?: string | null
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
    linhas.push(`• ${qtd(i.quantidade)}× ${i.descricao} — ${reais(i.quantidade * i.valorUnitarioCentavos)}`)
  }
  linhas.push('')
  linhas.push(`*Total: ${reais(totalCentavos)}*`)
  if (ctx.formaPagamento && ctx.formaPagamento.trim()) linhas.push(`Pagamento: ${ctx.formaPagamento.trim()}`)
  if (ctx.observacao && ctx.observacao.trim()) linhas.push(`Obs.: ${ctx.observacao.trim()}`)
  linhas.push('')
  linhas.push('Podemos confirmar? Responda *SIM* que já finalizo. 🙂')
  return linhas.join('\n')
}
