import { z } from 'zod'

/**
 * PEDIDO — contratos compartilhados (ADR-005, ADR-025, ADR-027).
 *
 * ⚠️ O corpo de uma requisição NUNCA carrega preço. Adicionar item leva `skuId`
 * e `quantidade`; o servidor resolve o preço pelo perfil do contato
 * (`preco-de-venda.ts`). Foi assim que o preço deixou de ser "o que a tela
 * mandou" — e é a única forma de o agente e a tela cotarem o mesmo número.
 */

export const ESTADOS_PEDIDO = [
  'rascunho', 'aguardando_confirmacao', 'confirmado', 'validando', 'enviando',
  'efetivado', 'falhou', 'aguardando_conferencia', 'cancelado',
] as const
export type EstadoPedido = (typeof ESTADOS_PEDIDO)[number]

/** Transições que o domínio aceita. Qualquer outra é `pedido.transicao_invalida`. */
export const TRANSICOES_PEDIDO: Readonly<Record<EstadoPedido, readonly EstadoPedido[]>> = {
  rascunho: ['aguardando_confirmacao', 'confirmado', 'validando', 'enviando', 'cancelado'],
  aguardando_confirmacao: ['confirmado', 'rascunho', 'cancelado'],
  confirmado: ['validando', 'enviando', 'cancelado'],
  validando: ['enviando', 'falhou', 'rascunho'],
  enviando: ['efetivado', 'falhou', 'aguardando_conferencia'],
  efetivado: [],
  falhou: ['enviando', 'validando', 'rascunho', 'cancelado'],
  aguardando_conferencia: ['efetivado', 'falhou'],
  cancelado: ['rascunho'],
}

export function podeTransitar(de: EstadoPedido, para: EstadoPedido): boolean {
  return TRANSICOES_PEDIDO[de].includes(para)
}

export const ORIGENS_PEDIDO = ['humano', 'agente'] as const
export type OrigemPedido = (typeof ORIGENS_PEDIDO)[number]

/** Entrada de item: SEM preço. */
export const itemPedidoEntrada = z.object({
  skuId: z.string().uuid(),
  quantidade: z.number().positive().max(100_000),
})
export type ItemPedidoEntrada = z.infer<typeof itemPedidoEntrada>

/**
 * ALÇADA do agente num canal (ADR-027): até onde ele vai sozinho.
 *
 * ⚠️ Desconto é ZERO por padrão e só sobe por decisão explícita do dono. Um
 * robô que "dá um desconto para fechar" às 23h é o modo de falha mais caro do
 * produto, e ele não acontece se o número não existir.
 */
export const alcadaAgente = z.object({
  /** Acima disto o pedido confirmado espera um vendedor efetivar. */
  valorMaxAutonomoCentavos: z.number().int().nonnegative().default(0),
  descontoMaxPct: z.number().min(0).max(100).default(0),
  /** Com o cliente confirmado e dentro do valor, o domínio efetiva no ERP sem humano. */
  efetivaSozinho: z.boolean().default(false),
})
export type AlcadaAgente = z.infer<typeof alcadaAgente>
export const ALCADA_PADRAO: AlcadaAgente = { valorMaxAutonomoCentavos: 0, descontoMaxPct: 0, efetivaSozinho: false }

export type DecisaoAlcada =
  | { readonly acao: 'efetivar' }
  | { readonly acao: 'aguardar_vendedor'; readonly motivo: 'acima_do_valor' | 'efetivacao_manual' | 'desconto' }

/** Regra pura: o pedido confirmado pode ser efetivado sem gente? */
export function decidirAlcada(
  pedido: { totalCentavos: number; descontoPct?: number },
  alcada: AlcadaAgente,
): DecisaoAlcada {
  if ((pedido.descontoPct ?? 0) > alcada.descontoMaxPct) return { acao: 'aguardar_vendedor', motivo: 'desconto' }
  if (!alcada.efetivaSozinho) return { acao: 'aguardar_vendedor', motivo: 'efetivacao_manual' }
  if (pedido.totalCentavos > alcada.valorMaxAutonomoCentavos) return { acao: 'aguardar_vendedor', motivo: 'acima_do_valor' }
  return { acao: 'efetivar' }
}
