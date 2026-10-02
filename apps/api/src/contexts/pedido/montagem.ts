import { randomUUID } from 'node:crypto'
import { perfilDeCotacao, type ItemPedidoEntrada, type OrigemPedido, type PerfilPreco } from '@geracrm/shared'
import type { Sql } from '../../db/index.js'
import { jsonbDe } from '../../db/jsonb.js'
import { precosDeVenda } from './preco-de-venda.js'
import { regrasPedidoDe, type RegrasPedido } from './regras-pedido.js'

/**
 * MONTAGEM DO RASCUNHO — o caso de uso que a tela, o app e o AGENTE compartilham
 * (ADR-005, ADR-025).
 *
 * ⚠️ O preço NUNCA entra por aqui. `adicionarItemPorSku` recebe `skuId` e
 *    `quantidade`, e resolve o preço por `precosDeVenda()` com o perfil do
 *    contato (`contato.perfil_preco`, padrão atacado). Antes disto a rota
 *    aceitava `valorUnitarioCentavos` do cliente — e um robô montando pedido
 *    por essa rota cotaria o que quisesse. A regra de preço mora num lugar só
 *    (`preco-de-venda.ts`); aqui ela é consumida, não reescrita.
 *
 * ⚠️ Toda função roda na transação de tenant de quem chama (`comTenant` /
 *    `comTenantServico`). A RLS é quem faz um SKU de outra empresa voltar como
 *    `sku_desconhecido`, não um WHERE escrito à mão.
 */

/** Teto de quantidade por item — o mesmo do schema de borda `itemPedidoEntrada`. */
const QUANTIDADE_MAXIMA = 100_000

/** Estados em que o conteúdo do pedido ainda pode mudar. */
const EDITAVEIS: readonly string[] = ['rascunho']

export interface EntradaRascunho {
  readonly conversaId?: string | null
  readonly contatoId?: string | null
  /** Rótulo do rascunho (tela robusta com N rascunhos por cliente). */
  readonly nome?: string | null
  /** Força um rascunho novo em vez de reaproveitar o da conversa. */
  readonly novo?: boolean
  /** Quem está montando. Padrão 'humano'; o agente passa 'agente' (ADR-027). */
  readonly origem?: OrigemPedido
}

/**
 * Reaproveita o rascunho aberto da conversa ou cria um. ⚠️ Vários por cliente
 * (0049 soltou o índice único por conversa), mas a CONTINUIDADE do chat é um
 * rascunho só: dois dispositivos (ou o agente e o vendedor) iniciando pedido na
 * mesma conversa ao mesmo tempo recebem o MESMO id. Sem o índice, quem garante
 * é um lock consultivo por conversa, preso à transação: o segundo espera o
 * primeiro commitar e aí enxerga o rascunho dele.
 *
 * O contato vem do parâmetro ou, faltando, da própria conversa — pedido que
 * nasce no chat não pode ficar "sem cliente" na lista.
 */
export async function obterOuCriarRascunho(
  tx: Sql, entrada: EntradaRascunho,
): Promise<{ id: string; criado: boolean }> {
  const conversaId = entrada.conversaId ?? null
  const forcarNovo = entrada.novo === true || !!entrada.nome?.trim()
  if (conversaId && !forcarNovo) {
    // ⚠️ Chave do lock inclui o tenant: duas empresas com o mesmo id de
    //    conversa (impossível com UUID, mas o hash é de 64 bits) não se travam.
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(tenant_atual()::text || ':rascunho:' || ${conversaId}, 0))`
    const existente = await rascunhoDaConversa(tx, conversaId)
    if (existente) return { id: existente, criado: false }
  }
  const id = randomUUID()
  await tx`
    INSERT INTO pedido (tenant_id, id, contato_id, conversa_id, nome, estado, origem)
    VALUES (
      tenant_atual(), ${id},
      COALESCE(
        ${entrada.contatoId ?? null}::uuid,
        (SELECT cv.contato_id FROM conversa cv
          WHERE cv.tenant_id = tenant_atual() AND cv.id = ${conversaId}::uuid)
      ),
      ${conversaId}, ${entrada.nome?.trim() || null}, 'rascunho', ${entrada.origem ?? 'humano'})`
  return { id, criado: true }
}

async function rascunhoDaConversa(tx: Sql, conversaId: string): Promise<string | null> {
  const [r] = await tx<{ id: string }[]>`
    SELECT id FROM pedido
     WHERE tenant_id = tenant_atual() AND conversa_id = ${conversaId} AND estado = 'rascunho'
     ORDER BY atualizado_em DESC LIMIT 1`
  return r?.id ?? null
}

/**
 * O perfil de preço do contato: o DECLARADO em `contato.perfil_preco`, ou o
 * padrão (atacado, ADR-019). Contato nulo (balcão) ou inexistente → padrão.
 * Nunca falha: cotar sempre acontece, o que muda é a tabela.
 */
export async function perfilDoContato(tx: Sql, contatoId: string | null | undefined): Promise<PerfilPreco> {
  if (!contatoId) return perfilDeCotacao(null)
  const [c] = await tx<{ perfil_preco: string | null }[]>`
    SELECT perfil_preco FROM contato WHERE tenant_id = tenant_atual() AND id = ${contatoId}`
  return perfilDeCotacao(c?.perfil_preco)
}

export type RegraQuantidade = 'maior_que_zero' | 'acima_do_teto'

export type ResultadoAdicionarItem =
  | {
      readonly tipo: 'ok'
      readonly seq: number
      /** Quantidade da linha depois da inclusão (soma, se o SKU já estava). */
      readonly quantidade: number
      readonly valorUnitarioCentavos: number
      readonly totalCentavos: number
    }
  | { readonly tipo: 'pedido_nao_encontrado' }
  | { readonly tipo: 'pedido_imutavel'; readonly estado: string }
  | { readonly tipo: 'sku_desconhecido' }
  | { readonly tipo: 'sem_preco' }
  | { readonly tipo: 'quantidade_invalida'; readonly regra: RegraQuantidade }
  | { readonly tipo: 'estoque_insuficiente'; readonly disponivel: number; readonly skuSnapshot: string }

export interface OpcoesItem {
  /**
   * Perfil a cotar, por cima do perfil do contato. ⚠️ Transitório: existe para
   * o console, cujo botão varejo/atacado ainda não grava no contato (raia R7).
   * O agente NÃO passa isto — cota sempre pelo contato.
   */
  readonly perfil?: PerfilPreco
}

/**
 * Adiciona um SKU ao rascunho, com preço resolvido no servidor. O SKU que já
 * está no rascunho recebe a quantidade SOMADA à linha existente (e mantém o
 * preço combinado, INV-25) — "coloca mais 2" não vira segunda linha.
 *
 * Estoque: só valida quando `sku_saldo` tem linha. Sem linha, o tenant não
 * controla saldo aqui (ADR-008: a validação migra para a efetivação).
 */
export async function adicionarItemPorSku(
  tx: Sql, pedidoId: string, entrada: ItemPedidoEntrada, opcoes: OpcoesItem = {},
): Promise<ResultadoAdicionarItem> {
  const pedido = await pedidoEditavel(tx, pedidoId)
  if (pedido.tipo !== 'ok') return pedido
  const qtd = validarQuantidade(entrada.quantidade)
  if (qtd) return qtd

  const perfil = opcoes.perfil ?? await perfilDoContato(tx, pedido.contatoId)
  const preco = (await precosDeVenda(tx, [entrada.skuId], perfil)).get(entrada.skuId)
  if (!preco || preco.situacao === 'sku_desconhecido') return { tipo: 'sku_desconhecido' }
  if (preco.situacao === 'sem_preco') return { tipo: 'sem_preco' }

  const [sku] = await tx<{ atributos: Record<string, string>; codigo_barras: string | null; referencia: string; descricao: string }[]>`
    SELECT s.atributos, s.codigo_barras, p.referencia, p.descricao
      FROM sku s JOIN produto p ON p.tenant_id = s.tenant_id AND p.id = s.produto_id
     WHERE s.tenant_id = tenant_atual() AND s.id = ${entrada.skuId}`
  if (!sku) return { tipo: 'sku_desconhecido' }
  const skuSnapshot = sku.codigo_barras ?? sku.referencia

  const [linha] = await tx<{ seq: number; quantidade: string; valor_unitario_centavos: string }[]>`
    SELECT seq, quantidade::text, valor_unitario_centavos::text FROM pedido_item
     WHERE tenant_id = tenant_atual() AND pedido_id = ${pedidoId} AND sku_id = ${entrada.skuId}
     ORDER BY seq LIMIT 1`
  const quantidadeFinal = (linha ? Number(linha.quantidade) : 0) + entrada.quantidade

  const estoque = await conferirEstoque(tx, entrada.skuId, quantidadeFinal, skuSnapshot)
  if (estoque) return estoque

  let seq: number
  let valorUnitario: number
  if (linha) {
    seq = linha.seq
    valorUnitario = Number(linha.valor_unitario_centavos)
    await tx`UPDATE pedido_item SET quantidade = ${quantidadeFinal}
              WHERE tenant_id = tenant_atual() AND pedido_id = ${pedidoId} AND seq = ${seq}`
  } else {
    valorUnitario = preco.centavos
    const [nova] = await tx<{ seq: number }[]>`
      INSERT INTO pedido_item (tenant_id, pedido_id, seq, sku_id, sku_snapshot,
                               descricao_snapshot, grade_snapshot, quantidade, valor_unitario_centavos)
      VALUES (tenant_atual(), ${pedidoId},
              (SELECT coalesce(max(seq), 0) + 1 FROM pedido_item
                WHERE tenant_id = tenant_atual() AND pedido_id = ${pedidoId}),
              ${entrada.skuId}, ${skuSnapshot}, ${sku.descricao},
              ${jsonbDe(sku.atributos ?? {})}::text::jsonb,
              ${entrada.quantidade}, ${valorUnitario})
      RETURNING seq`
    seq = nova!.seq
  }
  const totalCentavos = await recalcularTotais(tx, pedidoId)
  return { tipo: 'ok', seq, quantidade: quantidadeFinal, valorUnitarioCentavos: valorUnitario, totalCentavos }
}

export type ResultadoAlterarItem =
  | { readonly tipo: 'ok'; readonly totalCentavos: number }
  | { readonly tipo: 'pedido_nao_encontrado' }
  | { readonly tipo: 'pedido_imutavel'; readonly estado: string }
  | { readonly tipo: 'item_nao_encontrado' }
  | { readonly tipo: 'quantidade_invalida'; readonly regra: RegraQuantidade }
  | { readonly tipo: 'estoque_insuficiente'; readonly disponivel: number; readonly skuSnapshot: string }

/** Troca a quantidade de uma linha do rascunho (recalcula totais). */
export async function alterarQuantidade(
  tx: Sql, pedidoId: string, seq: number, quantidade: number,
): Promise<ResultadoAlterarItem> {
  const pedido = await pedidoEditavel(tx, pedidoId)
  if (pedido.tipo !== 'ok') return pedido
  const qtd = validarQuantidade(quantidade)
  if (qtd) return qtd
  const [item] = await tx<{ sku_id: string | null; sku_snapshot: string }[]>`
    SELECT sku_id, sku_snapshot FROM pedido_item
     WHERE tenant_id = tenant_atual() AND pedido_id = ${pedidoId} AND seq = ${seq}`
  if (!item) return { tipo: 'item_nao_encontrado' }
  if (item.sku_id) {
    const estoque = await conferirEstoque(tx, item.sku_id, quantidade, item.sku_snapshot)
    if (estoque) return estoque
  }
  await tx`UPDATE pedido_item SET quantidade = ${quantidade}
            WHERE tenant_id = tenant_atual() AND pedido_id = ${pedidoId} AND seq = ${seq}`
  return { tipo: 'ok', totalCentavos: await recalcularTotais(tx, pedidoId) }
}

export type ResultadoRemoverItem =
  | { readonly tipo: 'ok'; readonly totalCentavos: number }
  | { readonly tipo: 'pedido_nao_encontrado' }
  | { readonly tipo: 'pedido_imutavel'; readonly estado: string }
  | { readonly tipo: 'item_nao_encontrado' }

/** Remove uma linha do rascunho (recalcula totais). */
export async function removerItem(tx: Sql, pedidoId: string, seq: number): Promise<ResultadoRemoverItem> {
  const pedido = await pedidoEditavel(tx, pedidoId)
  if (pedido.tipo !== 'ok') return pedido
  const apagados = await tx<{ seq: number }[]>`
    DELETE FROM pedido_item WHERE tenant_id = tenant_atual() AND pedido_id = ${pedidoId} AND seq = ${seq}
    RETURNING seq`
  if (apagados.length === 0) return { tipo: 'item_nao_encontrado' }
  return { tipo: 'ok', totalCentavos: await recalcularTotais(tx, pedidoId) }
}

export interface PedidoLido {
  readonly id: string
  readonly estado: string
  readonly origem: OrigemPedido
  readonly descontoPct: number
  readonly contatoId: string | null
  readonly conversaId: string | null
  readonly nome: string | null
  readonly totalCentavos: number
  readonly totalPecas: number
  readonly versaoConteudo: number
  readonly formaPagamento: string | null
  readonly observacao: string | null
}

export interface ItemLido {
  readonly seq: number
  readonly skuId: string | null
  readonly skuSnapshot: string
  readonly descricaoSnapshot: string
  readonly grade: Record<string, string>
  readonly quantidade: number
  readonly valorUnitarioCentavos: number
}

/** O pedido com seus itens, tipado — para o agente ler o carrinho sem SQL. */
export async function lerRascunho(
  tx: Sql, pedidoId: string,
): Promise<{ pedido: PedidoLido; itens: ItemLido[] } | null> {
  const [p] = await tx<{
    id: string; estado: string; origem: OrigemPedido; desconto_pct: string; contato_id: string | null
    conversa_id: string | null; nome: string | null; total_centavos: string; total_pecas: string
    versao_conteudo: number; forma_pagamento: string | null; observacao: string | null
  }[]>`
    SELECT id, estado, origem, desconto_pct::text, contato_id, conversa_id, nome,
           total_centavos::text, total_pecas::text, versao_conteudo, forma_pagamento, observacao
      FROM pedido WHERE tenant_id = tenant_atual() AND id = ${pedidoId}`
  if (!p) return null
  const itens = await tx<{
    seq: number; sku_id: string | null; sku_snapshot: string; descricao_snapshot: string
    grade_snapshot: Record<string, string>; quantidade: string; valor_unitario_centavos: string
  }[]>`
    SELECT seq, sku_id, sku_snapshot, descricao_snapshot, grade_snapshot,
           quantidade::text, valor_unitario_centavos::text
      FROM pedido_item WHERE tenant_id = tenant_atual() AND pedido_id = ${pedidoId} ORDER BY seq`
  return {
    pedido: {
      id: p.id, estado: p.estado, origem: p.origem, descontoPct: Number(p.desconto_pct),
      contatoId: p.contato_id, conversaId: p.conversa_id, nome: p.nome,
      totalCentavos: Number(p.total_centavos), totalPecas: Number(p.total_pecas),
      versaoConteudo: p.versao_conteudo, formaPagamento: p.forma_pagamento, observacao: p.observacao,
    },
    itens: itens.map((i) => ({
      seq: i.seq, skuId: i.sku_id, skuSnapshot: i.sku_snapshot, descricaoSnapshot: i.descricao_snapshot,
      grade: i.grade_snapshot ?? {}, quantidade: Number(i.quantidade),
      valorUnitarioCentavos: Number(i.valor_unitario_centavos),
    })),
  }
}

/**
 * Recalcula totais na MESMA transação da mutação — nunca defasa da linha — e
 * incrementa `versao_conteudo` (chave idempotente da efetivação, INV-29, e
 * guarda da proposta, ADR-027). Devolve o total em centavos.
 */
export async function recalcularTotais(tx: Sql, pedidoId: string): Promise<number> {
  const [r] = await tx<{ total_centavos: string }[]>`
    UPDATE pedido SET
      total_centavos = coalesce((SELECT sum(quantidade * valor_unitario_centavos)::bigint
                                   FROM pedido_item WHERE tenant_id = tenant_atual() AND pedido_id = ${pedidoId}), 0),
      total_pecas    = coalesce((SELECT sum(quantidade) FROM pedido_item
                                  WHERE tenant_id = tenant_atual() AND pedido_id = ${pedidoId}), 0),
      versao_conteudo = versao_conteudo + 1,
      atualizado_em  = now()
     WHERE tenant_id = tenant_atual() AND id = ${pedidoId}
    RETURNING total_centavos::text`
  return Number(r?.total_centavos ?? 0)
}

/**
 * Volta um pedido que espera o "sim" para rascunho — o cliente pediu para
 * mudar algo. ⚠️ Invalida a proposta vigente no mesmo commit: o resumo que ele
 * viu já não descreve o pedido, e um "sim" tardio não pode confirmá-lo.
 */
export async function voltarARascunho(
  tx: Sql, pedidoId: string,
): Promise<{ tipo: 'ok' } | { tipo: 'pedido_nao_encontrado' } | { tipo: 'estado_invalido'; estado: string }> {
  const [p] = await tx<{ estado: string }[]>`
    SELECT estado FROM pedido WHERE tenant_id = tenant_atual() AND id = ${pedidoId}`
  if (!p) return { tipo: 'pedido_nao_encontrado' }
  if (p.estado === 'rascunho') return { tipo: 'ok' }
  if (p.estado !== 'aguardando_confirmacao') return { tipo: 'estado_invalido', estado: p.estado }
  await tx`
    UPDATE pedido SET estado = 'rascunho', resumo_enviado_em = NULL, atualizado_em = now()
     WHERE tenant_id = tenant_atual() AND id = ${pedidoId} AND estado = 'aguardando_confirmacao'`
  await tx`
    UPDATE pedido_proposta SET vigente = false
     WHERE tenant_id = tenant_atual() AND pedido_id = ${pedidoId} AND vigente`
  return { tipo: 'ok' }
}

/**
 * As regras comerciais do perfil vertical ATIVO do tenant. ⚠️ `tenant` não tem
 * RLS (tabela global); o perfil tem, e é por ele que a leitura é isolada.
 */
export async function regrasPedidoDoTenant(tx: Sql): Promise<RegrasPedido> {
  const [r] = await tx<{ regras_pedido: unknown }[]>`
    SELECT pv.regras_pedido
      FROM perfil_vertical pv
      JOIN tenant t ON t.id = pv.tenant_id AND t.perfil_vertical_id = pv.id
     WHERE pv.tenant_id = tenant_atual()`
  return regrasPedidoDe(r?.regras_pedido)
}

// ───────── internos ─────────

async function pedidoEditavel(
  tx: Sql, pedidoId: string,
): Promise<
  | { tipo: 'ok'; contatoId: string | null }
  | { tipo: 'pedido_nao_encontrado' }
  | { tipo: 'pedido_imutavel'; estado: string }
> {
  const [p] = await tx<{ estado: string; contato_id: string | null }[]>`
    SELECT estado, contato_id FROM pedido WHERE tenant_id = tenant_atual() AND id = ${pedidoId}`
  if (!p) return { tipo: 'pedido_nao_encontrado' }
  // ⚠️ Só rascunho recebe item: pedido que espera o "sim" volta a rascunho
  //    ANTES (`voltarARascunho`), e efetivado é imutável.
  if (!EDITAVEIS.includes(p.estado)) return { tipo: 'pedido_imutavel', estado: p.estado }
  return { tipo: 'ok', contatoId: p.contato_id }
}

function validarQuantidade(q: number): { tipo: 'quantidade_invalida'; regra: RegraQuantidade } | null {
  if (!Number.isFinite(q) || q <= 0) return { tipo: 'quantidade_invalida', regra: 'maior_que_zero' }
  if (q > QUANTIDADE_MAXIMA) return { tipo: 'quantidade_invalida', regra: 'acima_do_teto' }
  return null
}

/** Saldo da última sincronização (0023). Sem linha = não controla → passa. */
async function conferirEstoque(
  tx: Sql, skuId: string, quantidade: number, skuSnapshot: string,
): Promise<{ tipo: 'estoque_insuficiente'; disponivel: number; skuSnapshot: string } | null> {
  const [s] = await tx<{ quantidade: string }[]>`
    SELECT quantidade::text FROM sku_saldo WHERE tenant_id = tenant_atual() AND sku_id = ${skuId}`
  if (!s) return null
  const disponivel = Number(s.quantidade)
  return quantidade > disponivel ? { tipo: 'estoque_insuficiente', disponivel, skuSnapshot } : null
}
