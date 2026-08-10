/**
 * Resumo do pedido em texto para mandar ao cliente pelo WhatsApp. Puro e
 * testável; formatação amigável (negrito do WhatsApp, quantidade sem casas
 * quando inteira).
 */
export interface ItemResumo {
  readonly descricao: string
  readonly quantidade: number
  readonly valorUnitarioCentavos: number
}

function reais(centavos: number): string {
  return (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}
function qtd(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toLocaleString('pt-BR', { maximumFractionDigits: 3 })
}

export function resumoPedidoTexto(itens: readonly ItemResumo[], totalCentavos: number): string {
  const linhas = itens.map(
    (i) => `• ${qtd(i.quantidade)}× ${i.descricao} — ${reais(i.quantidade * i.valorUnitarioCentavos)}`,
  )
  return `*Resumo do seu pedido*\n\n${linhas.join('\n')}\n\n*Total: ${reais(totalCentavos)}*`
}
