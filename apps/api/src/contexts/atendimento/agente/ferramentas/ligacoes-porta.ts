import type { AtributosSku } from '@geracrm/shared'
import type { ContextoFerramenta } from './porta.js'

/**
 * As LIGAÇÕES das ferramentas com os outros contextos — portas definidas AQUI,
 * pelo que o vendedor precisa, e implementadas em `ligacoes.ts` sobre os
 * módulos públicos de `catalogo/` e `pedido/`.
 *
 * ⚠️ É o que deixa o laço testável sem banco de catálogo e sem ERP: os testes
 * injetam versões falsas destas portas. E é o que mantém o agente ignorante do
 * formato interno dos outros contextos (ADR-008, mesma regra dos conectores).
 */

export interface SkuParaLlm {
  readonly skuId: string
  readonly atributos: AtributosSku
  readonly precoCentavos: number | null
  /** número = saldo apurado; null = não controla estoque; 'desconhecido' = ERP não informou. */
  readonly saldo: number | null | 'desconhecido'
}

export interface ProdutoParaLlm {
  readonly produtoId: string
  readonly referencia: string
  readonly produto: string
  readonly categoria: string | null
  readonly descricao: string | null
  readonly skus: readonly SkuParaLlm[]
}

export interface CatalogoPorta {
  buscar(ctx: ContextoFerramenta, p: { consulta: string; limite: number }): Promise<{ itens: readonly ProdutoParaLlm[] }>
  detalhar(ctx: ContextoFerramenta, produtoId: string): Promise<ProdutoParaLlm | null>
  precoEEstoque(ctx: ContextoFerramenta, skuIds: readonly string[]): Promise<readonly {
    skuId: string; situacao: 'cotado' | 'sem_preco' | 'sku_desconhecido'; precoCentavos?: number; saldo: number | null | 'desconhecido'
  }[]>
}

export interface ItemDoPedidoParaLlm {
  readonly seq: number
  readonly descricao: string
  readonly atributos: AtributosSku
  readonly quantidade: number
  readonly valorUnitarioCentavos: number
  readonly subtotalCentavos: number
}

export interface PedidoParaLlm {
  readonly pedidoId: string
  readonly estado: string
  readonly itens: readonly ItemDoPedidoParaLlm[]
  readonly totalCentavos: number
}

export type SituacaoItem =
  | 'ok' | 'sku_desconhecido' | 'sem_preco' | 'estoque_insuficiente' | 'pedido_imutavel' | 'quantidade_invalida' | 'item_nao_encontrado'

export interface PedidoPorta {
  ver(ctx: ContextoFerramenta): Promise<PedidoParaLlm | null>
  itens(ctx: ContextoFerramenta, p:
    | { acao: 'adicionar'; skuId: string; quantidade: number }
    | { acao: 'alterar'; seq: number; quantidade: number }
    | { acao: 'remover'; seq: number },
  ): Promise<{ situacao: SituacaoItem; detalhe?: string; pedido?: PedidoParaLlm }>
  propor(ctx: ContextoFerramenta): Promise<
    | { situacao: 'ok'; resumo: string; totalCentavos: number; expiraEm: string }
    | { situacao: 'vazio' | 'nao_rascunho' | 'regras' | 'envio_recusado' | 'indisponivel'; detalhe?: string; centavos?: readonly number[] }>
  recentes(ctx: ContextoFerramenta): Promise<readonly { pedidoId: string; estado: string; totalCentavos: number; criadoEm: string; itens: number }[]>
}

export interface ConhecimentoPorta {
  buscar(ctx: ContextoFerramenta, pergunta: string): Promise<{ trechos: readonly { texto: string; fonte: string }[] }>
}

export interface Ligacoes {
  readonly catalogo?: CatalogoPorta | undefined
  readonly pedido?: PedidoPorta | undefined
  readonly conhecimento: ConhecimentoPorta
}
