import type { FastifyInstance } from 'fastify'
import { exigirTenant } from '../../plugins/tenant.js'
import { condicaoContato, escopoDaRequisicao } from './escopo.js'

/**
 * BI de vendas — rankings de leitura sobre `venda`/`item_venda` (fonte de verdade
 * de compra), num período. ⚠️ Vendas canceladas ficam FORA de todos os números.
 *
 * Top-N (10) é um AGREGADO de ranking, não uma lista de domínio paginável — a
 * regra de "sem top-N cru" mira grids ilimitados (kanban, conversas), não um
 * pódio de leitura. Cada ranking é limitado e rotulado como "top 10".
 *
 * O período é fechado (7/30/90 dias) para o range casar com as partições de venda.
 *
 * Cada ranking devolve o top 10 com `<lista>Truncado` (havia mais grupos) e `<lista>Total`
 * (grupos antes do corte, pela janela sobre o próprio GROUP BY).
 */
const DIAS_VALIDOS = new Set([7, 30, 90])
const TOP_RANKING = 10

export async function rotasBi(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { dias?: string } }>(
    '/v1/bi', { preHandler: exigirTenant },
    async (req, reply) => {
      const dias = DIAS_VALIDOS.has(Number(req.query.dias)) ? Number(req.query.dias) : 30
      const dados = await req.comTenant(async (tx) => {
        const desde = tx`now() - (${dias} || ' days')::interval`
        // ⚠️ Escopo (D3): os rankings COM NOME (clientes, vendedores) mostram só
        //    o que quem pede enxerga. O de produtos é agregado sem pessoa.
        const escopo = await escopoDaRequisicao(tx, req)
        const vendedorVisivel = escopo.tipo === 'tudo' ? tx`true`
          : escopo.usuarioId === null ? tx`false`
          : escopo.tipo === 'carteira' ? tx`v.usuario_id = ${escopo.usuarioId}::uuid`
          : tx`(v.usuario_id = ${escopo.usuarioId}::uuid OR EXISTS (
                  SELECT 1 FROM usuario_filial bi_uf
                   WHERE bi_uf.tenant_id = v.tenant_id AND bi_uf.usuario_id = v.usuario_id
                     AND bi_uf.filial_id = ANY(${[...escopo.filialIds]}::uuid[])))`

        // Cada ranking pede TOP+1 linhas: a sobra diz se cortou. `total_grupos` é a janela sobre o
        // próprio GROUP BY (sem varredura extra) — o número de grupos antes do LIMIT.
        const topClientes = await tx<{ contato_id: string; nome: string; receita: string; qtd: number; total_grupos: number }[]>`
          SELECT v.contato_id, c.nome, sum(v.valor_centavos)::text AS receita, count(*)::int AS qtd,
                 (count(*) OVER ())::int AS total_grupos
            FROM venda v
            JOIN contato c ON c.tenant_id = v.tenant_id AND c.id = v.contato_id
           WHERE v.tenant_id = tenant_atual() AND v.cancelada_em IS NULL
             AND v.contato_id IS NOT NULL AND v.ocorrida_em >= ${desde}
             AND ${condicaoContato(tx, escopo, 'c')}
           GROUP BY v.contato_id, c.nome
           ORDER BY sum(v.valor_centavos) DESC, v.contato_id LIMIT ${TOP_RANKING + 1}`

        const topProdutos = await tx<{ rotulo: string; quantidade: string; receita: string; total_grupos: number }[]>`
          SELECT COALESCE(p.descricao, iv.sku_externo, 'Sem descrição') AS rotulo,
                 sum(iv.quantidade)::text AS quantidade,
                 sum(iv.quantidade * iv.valor_unitario_centavos)::text AS receita,
                 (count(*) OVER ())::int AS total_grupos
            FROM item_venda iv
            JOIN venda v ON v.tenant_id = iv.tenant_id AND v.id = iv.venda_id
                        AND v.ocorrida_em = iv.venda_ocorrida_em
            LEFT JOIN sku s     ON s.tenant_id = iv.tenant_id AND s.id = iv.sku_id
            LEFT JOIN produto p ON p.tenant_id = s.tenant_id  AND p.id = s.produto_id
           WHERE iv.tenant_id = tenant_atual() AND v.cancelada_em IS NULL
             AND iv.venda_ocorrida_em >= ${desde}
           GROUP BY COALESCE(p.descricao, iv.sku_externo, 'Sem descrição')
           ORDER BY sum(iv.quantidade * iv.valor_unitario_centavos) DESC, 1 LIMIT ${TOP_RANKING + 1}`

        const porVendedor = await tx<{ usuario_id: string | null; nome: string | null; receita: string; qtd: number; total_grupos: number }[]>`
          SELECT v.usuario_id, u.nome, sum(v.valor_centavos)::text AS receita, count(*)::int AS qtd,
                 (count(*) OVER ())::int AS total_grupos
            FROM venda v
            LEFT JOIN usuario u ON u.tenant_id = v.tenant_id AND u.id = v.usuario_id
           WHERE v.tenant_id = tenant_atual() AND v.cancelada_em IS NULL
             AND v.ocorrida_em >= ${desde} AND ${vendedorVisivel}
           GROUP BY v.usuario_id, u.nome
           ORDER BY sum(v.valor_centavos) DESC, v.usuario_id NULLS LAST LIMIT ${TOP_RANKING + 1}`

        return { topClientes, topProdutos, porVendedor }
      })

      const cortaClientes = dados.topClientes.length > TOP_RANKING
      const cortaProdutos = dados.topProdutos.length > TOP_RANKING
      const cortaVendedores = dados.porVendedor.length > TOP_RANKING
      const topo = <T>(linhas: readonly T[]): T[] => linhas.slice(0, TOP_RANKING) as T[]

      return reply.send({
        dias,
        topClientes: topo(dados.topClientes).map((r) => ({
          contatoId: r.contato_id, nome: r.nome, receitaCentavos: Number(r.receita), qtdVendas: r.qtd,
        })),
        topClientesTruncado: cortaClientes,
        topClientesTotal: dados.topClientes[0]?.total_grupos ?? 0,
        topProdutos: topo(dados.topProdutos).map((r) => ({
          rotulo: r.rotulo, quantidade: Number(r.quantidade), receitaCentavos: Number(r.receita),
        })),
        topProdutosTruncado: cortaProdutos,
        topProdutosTotal: dados.topProdutos[0]?.total_grupos ?? 0,
        porVendedor: topo(dados.porVendedor).map((r) => ({
          usuarioId: r.usuario_id, nome: r.nome ?? 'Sem vendedor', receitaCentavos: Number(r.receita), qtdVendas: r.qtd,
        })),
        porVendedorTruncado: cortaVendedores,
        porVendedorTotal: dados.porVendedor[0]?.total_grupos ?? 0,
      })
    },
  )
}
