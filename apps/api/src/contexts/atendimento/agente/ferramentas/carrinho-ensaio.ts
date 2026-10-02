import type { ItemDoPedidoParaLlm, PedidoParaLlm } from './ligacoes-porta.js'

/**
 * CARRINHO DE ENSAIO — o pedido do agente em SOMBRA, ASSISTIDO e SIMULAÇÃO.
 *
 * ⚠️ Nesses modos o agente não pode mexer no rascunho REAL da conversa: em
 * sombra a vendedora está montando o carrinho dela, e o robô "ensaiando" por
 * cima dele é exatamente o incidente que o modo existe para evitar. O ensaio
 * vive na memória do processo, por conversa, com TTL — suficiente para o
 * playground e para a semana de sombra; nunca vira linha em `pedido`.
 */
const TTL_MS = 2 * 60 * 60 * 1000
const MAX = 2_000
const carrinhos = new Map<string, { itens: ItemDoPedidoParaLlm[]; tocadoEm: number }>()

function chave(tenantId: string, conversaId: string): string { return `${tenantId}:${conversaId}` }

function limpar(agora: number): void {
  if (carrinhos.size < MAX) return
  for (const [k, v] of carrinhos) if (agora - v.tocadoEm > TTL_MS) carrinhos.delete(k)
  if (carrinhos.size >= MAX) carrinhos.delete(carrinhos.keys().next().value!)
}

export function lerCarrinhoEnsaio(tenantId: string, conversaId: string, agora = Date.now()): PedidoParaLlm | null {
  const c = carrinhos.get(chave(tenantId, conversaId))
  if (!c || agora - c.tocadoEm > TTL_MS) return null
  return montar(conversaId, c.itens)
}

export function alterarCarrinhoEnsaio(
  tenantId: string, conversaId: string,
  mudanca:
    | { acao: 'adicionar'; item: Omit<ItemDoPedidoParaLlm, 'seq' | 'subtotalCentavos'> & { skuId: string } }
    | { acao: 'alterar'; seq: number; quantidade: number }
    | { acao: 'remover'; seq: number },
  agora = Date.now(),
): { situacao: 'ok' | 'item_nao_encontrado'; pedido: PedidoParaLlm } {
  limpar(agora)
  const k = chave(tenantId, conversaId)
  const c = carrinhos.get(k) ?? { itens: [], tocadoEm: agora }
  c.tocadoEm = agora
  let situacao: 'ok' | 'item_nao_encontrado' = 'ok'
  if (mudanca.acao === 'adicionar') {
    const existente = c.itens.find((i) => (i as { skuId?: string }).skuId === mudanca.item.skuId)
    if (existente) {
      const q = existente.quantidade + mudanca.item.quantidade
      Object.assign(existente, { quantidade: q, subtotalCentavos: Math.round(existente.valorUnitarioCentavos * q) })
    } else {
      const seq = (c.itens[c.itens.length - 1]?.seq ?? 0) + 1
      c.itens.push({ ...mudanca.item, seq, subtotalCentavos: Math.round(mudanca.item.valorUnitarioCentavos * mudanca.item.quantidade) } as ItemDoPedidoParaLlm)
    }
  } else {
    const i = c.itens.findIndex((x) => x.seq === mudanca.seq)
    if (i < 0) situacao = 'item_nao_encontrado'
    else if (mudanca.acao === 'remover') c.itens.splice(i, 1)
    else Object.assign(c.itens[i]!, { quantidade: mudanca.quantidade, subtotalCentavos: Math.round(c.itens[i]!.valorUnitarioCentavos * mudanca.quantidade) })
  }
  carrinhos.set(k, c)
  return { situacao, pedido: montar(conversaId, c.itens) }
}

export function esquecerCarrinhoEnsaio(tenantId: string, conversaId: string): void {
  carrinhos.delete(chave(tenantId, conversaId))
}

function montar(conversaId: string, itens: ItemDoPedidoParaLlm[]): PedidoParaLlm {
  return {
    pedidoId: `ensaio:${conversaId}`, estado: 'ensaio',
    itens: itens.map((i) => ({ seq: i.seq, descricao: i.descricao, atributos: i.atributos, quantidade: i.quantidade, valorUnitarioCentavos: i.valorUnitarioCentavos, subtotalCentavos: i.subtotalCentavos })),
    totalCentavos: itens.reduce((a, i) => a + i.subtotalCentavos, 0),
  }
}
