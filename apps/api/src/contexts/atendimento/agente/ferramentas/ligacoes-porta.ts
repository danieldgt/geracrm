import type { AcoesPlaybook, AtributosSku, ObjecaoPlaybook } from '@geracrm/shared'
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

/**
 * AGENDA (C3) — o que o vendedor precisa para marcar reunião: ofertar horários livres
 * (responsável do contato primeiro, depois a filial) e confirmar a opção que o CLIENTE
 * escolheu. `real: false` = modo seco (nada é gravado). Erro de negócio é `situacao`
 * nomeada, nunca exceção.
 */
export interface OpcaoParaLlm {
  readonly n: number
  /** "qua, 05/11 às 15:00" — no fuso da loja. */
  readonly quando: string
  /** Primeiro nome de quem atende. */
  readonly com: string
}
/** Hora e data LOCAIS de um horário devolvido (fonte da guarda da resposta). */
export interface QuandoLocal { readonly data: string; readonly hora: string; readonly diaIso: number }

export type ResultadoOferta =
  | { readonly situacao: 'ok'; readonly opcoes: readonly (OpcaoParaLlm & QuandoLocal)[]; readonly ofertaId: string | null }
  | { readonly situacao: 'sem_horarios' | 'sem_vendedor' | 'dia_invalido' | 'limite_ofertas' }
  | { readonly situacao: 'ja_tem_reuniao'; readonly quando: string }
export type ResultadoConfirmacaoReuniao =
  | {
    readonly situacao: 'agendado'; readonly eventoId: string; readonly usuarioId: string; readonly quando: string; readonly com: string
    readonly contato: string; readonly local: QuandoLocal
  }
  | {
    readonly situacao: 'sem_oferta' | 'mesmo_turno' | 'oferta_nao_enviada' | 'oferta_vencida' | 'ja_confirmada' | 'sem_confirmacao'
      | 'cliente_recusou' | 'opcao_inexistente' | 'ocupado' | 'responsavel_indisponivel' | 'sem_conversa' | 'confirmacao_divergente'
  }
  | { readonly situacao: 'ja_tem_reuniao'; readonly quando: string }

export interface AgendaPorta {
  ofertar(ctx: ContextoFerramenta, p: { dia: string | null; real: boolean }): Promise<ResultadoOferta>
  confirmar(ctx: ContextoFerramenta, p: { opcao: number }): Promise<ResultadoConfirmacaoReuniao>
}

export interface Ligacoes {
  readonly catalogo?: CatalogoPorta | undefined
  readonly pedido?: PedidoPorta | undefined
  readonly conhecimento: ConhecimentoPorta
  /**
   * Ações que o PLAYBOOK do número habilita (P17). Ausente = todas ligadas.
   * `montarFerramentas` tira do menu o que estiver desligado; transferir e
   * perfil do cliente não são ação habilitável (sempre no menu).
   */
  readonly acoes?: AcoesPlaybook | undefined
  /**
   * Objeções do playbook publicado do número (G2) — o vocabulário de
   * `registrar_objecao`. Ausente/vazio = a ferramenta não entra no menu.
   */
  readonly objecoes?: readonly ObjecaoPlaybook[] | undefined
  /**
   * Agenda (C3): presente SÓ com o módulo Agenda ligado, a chave "O agente pode marcar
   * reuniões" do número ligada e o número em assistido/autônomo (`agendaNoTurno`). Ausente =
   * `agendar_reuniao` não entra no menu (ADR-029: não basta instruir o prompt).
   */
  readonly agenda?: AgendaPorta | undefined
}
