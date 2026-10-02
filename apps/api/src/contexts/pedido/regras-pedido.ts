import { z } from 'zod'

/**
 * REGRAS COMERCIAIS DO PEDIDO (PED-05, INV-27) — a validação que não existia.
 *
 * `perfil_vertical.regras_pedido` guarda pedido mínimo e múltiplo de grade
 * desde a 0003, e até aqui nada lia a coluna. Esta função é PURA: recebe as
 * regras e o pedido, devolve a violação NOMEADA com o que falta (PED-08). Quem
 * aplica é a proposta (antes de mandar o resumo ao cliente) e a efetivação
 * (antes de bater no ERP) — o agente e o vendedor passam pela mesma régua.
 *
 * ⚠️ O jsonb é entrada de borda: vem do banco, mas foi escrito por tela de
 *    configuração (ou à mão). Parse com Zod, e regra ilegível vale como
 *    ausente — bloquear toda venda por um JSON torto seria o modo de falha
 *    mais caro, e silencioso.
 *
 * Forma do jsonb (chaves em snake_case, como o resto das colunas jsonb):
 *
 *   { "minimo_pecas": 10, "minimo_centavos": 50000, "multiplo_pecas": 3 }
 *
 * - `minimo_pecas`    — total de peças do pedido não pode ficar abaixo.
 * - `minimo_centavos` — total em centavos não pode ficar abaixo.
 * - `multiplo_pecas`  — a quantidade de CADA item precisa ser múltipla
 *                       (grade fechada: vende de 3 em 3, de 6 em 6).
 *
 * Mix mínimo por categoria está em aberto no modelo (pergunta 3 da §12 dos
 * cenários BDD) e NÃO entra aqui até o dono do negócio responder.
 */
export const regrasPedido = z.object({
  minimo_pecas: z.number().nonnegative().optional(),
  minimo_centavos: z.number().int().nonnegative().optional(),
  multiplo_pecas: z.number().int().positive().optional(),
}).passthrough()

export type RegrasPedido = z.infer<typeof regrasPedido>

export const SEM_REGRAS: RegrasPedido = {}

/** Lê o jsonb da coluna. Ilegível → sem regras (ver ⚠️ acima). */
export function regrasPedidoDe(bruto: unknown): RegrasPedido {
  const r = regrasPedido.safeParse(bruto ?? {})
  return r.success ? r.data : SEM_REGRAS
}

export interface ItemParaRegras {
  /** O que identifica o item para o cliente/vendedor: descrição ou código. */
  readonly sku: string
  readonly quantidade: number
}

export interface PedidoParaRegras {
  readonly totalCentavos: number
  readonly totalPecas: number
  readonly itens: readonly ItemParaRegras[]
}

export type ViolacaoRegras =
  | {
      readonly tipo: 'abaixo_do_minimo'
      /** O que falta para atingir o mínimo — só as dimensões violadas. */
      readonly faltam: { readonly pecas?: number; readonly centavos?: number }
    }
  | { readonly tipo: 'multiplo_invalido'; readonly sku: string; readonly multiplo: number; readonly quantidade: number }

export type ResultadoRegras = { readonly tipo: 'ok' } | ViolacaoRegras

/**
 * Valida o pedido contra as regras. Devolve a PRIMEIRA violação, na ordem em
 * que o vendedor corrige: primeiro o item errado (múltiplo), depois o total
 * (mínimo) — ajustar um item muda o total, o contrário não.
 */
export function validarRegrasPedido(regras: RegrasPedido, pedido: PedidoParaRegras): ResultadoRegras {
  const multiplo = regras.multiplo_pecas
  if (multiplo !== undefined && multiplo > 1) {
    for (const item of pedido.itens) {
      // ⚠️ Quantidade fracionária nunca é múltiplo inteiro; o resto decide.
      if (item.quantidade % multiplo !== 0) {
        return { tipo: 'multiplo_invalido', sku: item.sku, multiplo, quantidade: item.quantidade }
      }
    }
  }

  const faltam: { pecas?: number; centavos?: number } = {}
  if (regras.minimo_pecas !== undefined && pedido.totalPecas < regras.minimo_pecas) {
    faltam.pecas = regras.minimo_pecas - pedido.totalPecas
  }
  if (regras.minimo_centavos !== undefined && pedido.totalCentavos < regras.minimo_centavos) {
    faltam.centavos = regras.minimo_centavos - pedido.totalCentavos
  }
  if (faltam.pecas !== undefined || faltam.centavos !== undefined) {
    return { tipo: 'abaixo_do_minimo', faltam }
  }
  return { tipo: 'ok' }
}

/** Texto da violação para a tela e para o chat (PED-08: o que falta, nomeado). */
export function mensagemViolacao(v: ViolacaoRegras): string {
  if (v.tipo === 'multiplo_invalido') {
    return `${v.sku} vende em múltiplos de ${v.multiplo} — a quantidade ${v.quantidade} não fecha a grade.`
  }
  const partes: string[] = []
  if (v.faltam.pecas !== undefined) partes.push(`faltam ${formatarQtd(v.faltam.pecas)} peça(s)`)
  if (v.faltam.centavos !== undefined) partes.push(`faltam R$ ${(v.faltam.centavos / 100).toFixed(2)}`)
  return `Pedido abaixo do mínimo — ${partes.join(' e ')}.`
}

function formatarQtd(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(3)
}
