import type { FastifyInstance } from 'fastify'
import { exigirTenant } from '../../plugins/tenant.js'

/**
 * BI de vendas — rankings de leitura sobre `venda`/`item_venda` (fonte de verdade
 * de compra), num período. ⚠️ Vendas canceladas ficam FORA de todos os números.
 *
 * Top-N (10) é um AGREGADO de ranking, não uma lista de domínio paginável — a
 * regra de "sem top-N cru" mira grids ilimitados (kanban, conversas), não um
 * pódio de leitura. Cada ranking é limitado e rotulado como "top 10".
 *
 * O período é fechado (7/30/90 dias) para o range casar com as partições de venda.
 */
const DIAS_VALIDOS = new Set([7, 30, 90])

export async function rotasBi(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { dias?: string } }>(
    '/v1/bi', { preHandler: exigirTenant },
    async (req, reply) => {
      const dias = DIAS_VALIDOS.has(Number(req.query.dias)) ? Number(req.query.dias) : 30
      const dados = await req.comTenant(async (tx) => {
        const desde = tx`now() - (${dias} || ' days')::interval`

        const topClientes = await tx<{ contato_id: string; nome: string; receita: string; qtd: number }[]>`
          SELECT v.contato_id, c.nome, sum(v.valor_centavos)::text AS receita, count(*)::int AS qtd
            FROM venda v
            JOIN contato c ON c.tenant_id = v.tenant_id AND c.id = v.contato_id
           WHERE v.tenant_id = tenant_atual() AND v.cancelada_em IS NULL
             AND v.contato_id IS NOT NULL AND v.ocorrida_em >= ${desde}
           GROUP BY v.contato_id, c.nome
           ORDER BY sum(v.valor_centavos) DESC LIMIT 10`

        const topProdutos = await tx<{ rotulo: string; quantidade: string; receita: string }[]>`
          SELECT COALESCE(p.descricao, iv.sku_externo, 'Sem descrição') AS rotulo,
                 sum(iv.quantidade)::text AS quantidade,
                 sum(iv.quantidade * iv.valor_unitario_centavos)::text AS receita
            FROM item_venda iv
            JOIN venda v ON v.tenant_id = iv.tenant_id AND v.id = iv.venda_id
                        AND v.ocorrida_em = iv.venda_ocorrida_em
            LEFT JOIN sku s     ON s.tenant_id = iv.tenant_id AND s.id = iv.sku_id
            LEFT JOIN produto p ON p.tenant_id = s.tenant_id  AND p.id = s.produto_id
           WHERE iv.tenant_id = tenant_atual() AND v.cancelada_em IS NULL
             AND iv.venda_ocorrida_em >= ${desde}
           GROUP BY COALESCE(p.descricao, iv.sku_externo, 'Sem descrição')
           ORDER BY sum(iv.quantidade * iv.valor_unitario_centavos) DESC LIMIT 10`

        const porVendedor = await tx<{ usuario_id: string | null; nome: string | null; receita: string; qtd: number }[]>`
          SELECT v.usuario_id, u.nome, sum(v.valor_centavos)::text AS receita, count(*)::int AS qtd
            FROM venda v
            LEFT JOIN usuario u ON u.tenant_id = v.tenant_id AND u.id = v.usuario_id
           WHERE v.tenant_id = tenant_atual() AND v.cancelada_em IS NULL
             AND v.ocorrida_em >= ${desde}
           GROUP BY v.usuario_id, u.nome
           ORDER BY sum(v.valor_centavos) DESC LIMIT 10`

        return { topClientes, topProdutos, porVendedor }
      })

      return reply.send({
        dias,
        topClientes: dados.topClientes.map((r) => ({
          contatoId: r.contato_id, nome: r.nome, receitaCentavos: Number(r.receita), qtdVendas: r.qtd,
        })),
        topProdutos: dados.topProdutos.map((r) => ({
          rotulo: r.rotulo, quantidade: Number(r.quantidade), receitaCentavos: Number(r.receita),
        })),
        porVendedor: dados.porVendedor.map((r) => ({
          usuarioId: r.usuario_id, nome: r.nome ?? 'Sem vendedor', receitaCentavos: Number(r.receita), qtdVendas: r.qtd,
        })),
      })
    },
  )
}
