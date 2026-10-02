import { randomUUID } from 'node:crypto'
import { comTenantServico, type Sql } from '../../../../db/index.js'
import { buscarCatalogo, detalharProduto, precoEEstoque, type ProdutoDetalhe } from '../../../catalogo/busca.js'
import {
  obterOuCriarRascunho, adicionarItemPorSku, alterarQuantidade, removerItem, lerRascunho,
} from '../../../pedido/montagem.js'
import { proporPedido, HORAS_VALIDADE_PROPOSTA } from '../../../pedido/proposta.js'
import type { CatalogoPorta, Ligacoes, PedidoParaLlm, PedidoPorta, ProdutoParaLlm, SituacaoItem } from './ligacoes-porta.js'
import type { ContextoFerramenta } from './porta.js'
import { conhecimentoDasPoliticas } from './conhecimento-politicas.js'

/**
 * As LIGAÇÕES padrão do agente com os outros contextos — implementadas sobre
 * os módulos PÚBLICOS de `catalogo/` (busca.ts) e `pedido/` (montagem.ts,
 * proposta.ts). O agente só conhece as portas de `ligacoes-porta.ts`.
 *
 * ⚠️ Catálogo só entra no menu quando o tenant tem produto INDEXADO: sem
 * índice, a ferramenta não existe e o prompt diz que não há catálogo neste
 * canal — degradação visível (ADR-008), não busca vazia fingindo que procurou.
 */
export async function ligacoesPadrao(cfg: { tenantId: string; politicas: string }): Promise<Ligacoes> {
  const temCatalogo = await comTenantServico(cfg.tenantId, async (tx) => {
    const [r] = await tx<{ tem: boolean }[]>`SELECT EXISTS (SELECT 1 FROM produto_indice WHERE tenant_id = tenant_atual()) AS tem`
    return r?.tem ?? false
  })
  return {
    catalogo: temCatalogo ? catalogoReal : undefined,
    pedido: pedidoReal,
    conhecimento: conhecimentoDasPoliticas(cfg.politicas),
  }
}

function paraLlm(p: ProdutoDetalhe): ProdutoParaLlm {
  return {
    produtoId: p.id, referencia: p.referencia, produto: p.descricao, categoria: p.categoria,
    descricao: p.descricaoLonga,
    skus: p.skus.filter((s) => s.ativo).map((s) => ({
      skuId: s.id, atributos: s.atributos, precoCentavos: s.precoCentavos, saldo: s.saldo,
    })),
  }
}

export const catalogoReal: CatalogoPorta = {
  async buscar(ctx, p) {
    const r = await comTenantServico(ctx.tenantId, (tx) => buscarCatalogo(tx, { consulta: p.consulta, perfil: ctx.perfil, limite: p.limite }))
    return { itens: r.itens.map(paraLlm) }
  },
  async detalhar(ctx, produtoId) {
    const d = await comTenantServico(ctx.tenantId, (tx) => detalharProduto(tx, produtoId, ctx.perfil))
    return d ? paraLlm(d) : null
  },
  async precoEEstoque(ctx, skuIds) {
    const m = await comTenantServico(ctx.tenantId, (tx) => precoEEstoque(tx, skuIds, ctx.perfil))
    return skuIds.map((skuId) => {
      const r = m.get(skuId)
      if (!r || r.situacao === 'sku_desconhecido') return { skuId, situacao: 'sku_desconhecido' as const, saldo: null }
      return { skuId, situacao: r.situacao, ...(r.situacao === 'cotado' ? { precoCentavos: r.centavos } : {}), saldo: r.saldo }
    })
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// Pedido
// ─────────────────────────────────────────────────────────────────────────────

/** O pedido ABERTO desta conversa (rascunho ou esperando o "sim"), se houver. */
async function pedidoAbertoDaConversa(tx: Sql, conversaId: string): Promise<string | null> {
  const [p] = await tx<{ id: string }[]>`
    SELECT id FROM pedido
     WHERE tenant_id = tenant_atual() AND conversa_id = ${conversaId}
       AND estado IN ('rascunho', 'aguardando_confirmacao')
     ORDER BY criado_em DESC LIMIT 1`
  return p?.id ?? null
}

async function lerParaLlm(tx: Sql, pedidoId: string): Promise<PedidoParaLlm | null> {
  const r = await lerRascunho(tx, pedidoId)
  if (!r) return null
  return {
    pedidoId: r.pedido.id, estado: r.pedido.estado, totalCentavos: r.pedido.totalCentavos,
    itens: r.itens.map((i) => ({
      seq: i.seq, descricao: i.descricaoSnapshot, atributos: i.grade, quantidade: i.quantidade,
      valorUnitarioCentavos: i.valorUnitarioCentavos, subtotalCentavos: Math.round(i.valorUnitarioCentavos * i.quantidade),
    })),
  }
}

const SITUACAO: Record<string, SituacaoItem> = {
  ok: 'ok', sku_desconhecido: 'sku_desconhecido', sem_preco: 'sem_preco', estoque_insuficiente: 'estoque_insuficiente',
  pedido_imutavel: 'pedido_imutavel', quantidade_invalida: 'quantidade_invalida', item_nao_encontrado: 'item_nao_encontrado',
  pedido_nao_encontrado: 'item_nao_encontrado',
}

/**
 * ⚠️ Em modo SOMBRA/ASSISTIDO e na SIMULAÇÃO, propor é ensaio: devolve o resumo
 * sem mandar nada ao cliente e sem mudar o estado do pedido. Só em AUTÔNOMO a
 * proposta vai pelo gateway e abre a janela de confirmação (ADR-027).
 */
export const pedidoReal: PedidoPorta = {
  async ver(ctx) {
    return comTenantServico(ctx.tenantId, async (tx) => {
      const id = await pedidoAbertoDaConversa(tx, ctx.conversaId)
      return id ? lerParaLlm(tx, id) : null
    })
  },
  async itens(ctx, p) {
    return comTenantServico(ctx.tenantId, async (tx) => {
      const { id } = await obterOuCriarRascunho(tx, { conversaId: ctx.conversaId, contatoId: ctx.contatoId, origem: 'agente' })
      const r = p.acao === 'adicionar'
        ? await adicionarItemPorSku(tx, id, { skuId: p.skuId, quantidade: p.quantidade })
        : p.acao === 'alterar'
          ? await alterarQuantidade(tx, id, p.seq, p.quantidade)
          : await removerItem(tx, id, p.seq)
      const situacao = SITUACAO[r.tipo] ?? 'item_nao_encontrado'
      const detalhe = r.tipo === 'estoque_insuficiente' ? `disponível: ${r.disponivel}`
        : r.tipo === 'quantidade_invalida' ? r.regra : r.tipo === 'pedido_imutavel' ? `estado ${r.estado}` : undefined
      const pedido = await lerParaLlm(tx, id)
      return { situacao, ...(detalhe ? { detalhe } : {}), ...(pedido ? { pedido } : {}) }
    })
  },
  async propor(ctx) {
    const id = await comTenantServico(ctx.tenantId, (tx) => pedidoAbertoDaConversa(tx, ctx.conversaId))
    if (!id) return { situacao: 'vazio' }
    if (ctx.modo !== 'autonomo') {
      const p = await comTenantServico(ctx.tenantId, (tx) => lerParaLlm(tx, id))
      if (!p || p.itens.length === 0) return { situacao: 'vazio' }
      const linhas = p.itens.map((i) => `${i.quantidade}x ${i.descricao}${Object.values(i.atributos).length ? ` (${Object.values(i.atributos).join(' ')})` : ''} — R$ ${(i.subtotalCentavos / 100).toFixed(2)}`)
      return {
        situacao: 'ok', totalCentavos: p.totalCentavos,
        resumo: `(ensaio — nada enviado) ${linhas.join('; ')}. Total R$ ${(p.totalCentavos / 100).toFixed(2)}`,
        expiraEm: new Date(ctx.agora.getTime() + HORAS_VALIDADE_PROPOSTA * 3_600_000).toISOString(),
      }
    }
    const r = await proporPedido(ctx.tenantId, id, ctx.agora, { remetenteNome: null })
    if (r.tipo === 'ok') return { situacao: 'ok', resumo: r.resumo, totalCentavos: r.totalCentavos, expiraEm: r.expiraEm.toISOString() }
    if (r.tipo === 'regras') return { situacao: 'regras', detalhe: r.mensagem }
    if (r.tipo === 'envio_recusado') return { situacao: 'envio_recusado', detalhe: r.motivo }
    if (r.tipo === 'nao_rascunho') return { situacao: 'nao_rascunho', detalhe: r.estado }
    if (r.tipo === 'vazio') return { situacao: 'vazio' }
    return { situacao: 'indisponivel', detalhe: r.tipo }
  },
  async recentes(ctx) {
    return comTenantServico(ctx.tenantId, async (tx) => {
      const linhas = await tx<{ id: string; estado: string; total_centavos: string; criado_em: Date; itens: number }[]>`
        SELECT p.id, p.estado, p.total_centavos::text, p.criado_em,
               (SELECT count(*)::int FROM pedido_item i WHERE i.tenant_id = p.tenant_id AND i.pedido_id = p.id) AS itens
          FROM pedido p WHERE p.tenant_id = tenant_atual() AND p.contato_id = ${ctx.contatoId}
         ORDER BY p.criado_em DESC LIMIT 5`
      return linhas.map((l) => ({ pedidoId: l.id, estado: l.estado, totalCentavos: Number(l.total_centavos), criadoEm: l.criado_em.toISOString(), itens: l.itens }))
    })
  },
}

// Mantém a assinatura estável para quem precisar injetar o contexto em testes.
export type { ContextoFerramenta }
void randomUUID
