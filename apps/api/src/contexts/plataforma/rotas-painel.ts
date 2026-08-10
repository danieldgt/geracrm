import type { FastifyInstance } from 'fastify'
import { exigirTenant } from '../../plugins/tenant.js'
import { distribuicaoRfv } from '../crm/rotas-segmentos.js'

/**
 * Painel Início (Onda 2) — o negócio hoje em 3 segundos. Só LEITURA/agregação
 * sobre o que já existe (venda, metricas_contato, pedido). ⚠️ Mediana ao lado da
 * média é boa prática (funil-de-vendas), mas para o MVP a média + nº de vendas
 * já dá o contexto; a mediana entra quando o volume justificar.
 */
export async function rotasPainel(app: FastifyInstance): Promise<void> {
  app.get('/v1/painel/inicio', { preHandler: exigirTenant }, async (req, reply) => {
    const dados = await req.comTenant(async (tx) => {
      const [v30] = await tx<{ n: number; total: string; ticket: string | null }[]>`
        SELECT count(*)::int AS n, coalesce(sum(valor_centavos), 0)::text AS total,
               round(avg(valor_centavos))::text AS ticket
          FROM venda
         WHERE tenant_id = tenant_atual() AND cancelada_em IS NULL
           AND ocorrida_em >= now() - interval '30 days'`
      const [clientes] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM metricas_contato WHERE tenant_id = tenant_atual()`
      const pedidos = await tx<{ estado: string; n: number }[]>`
        SELECT estado, count(*)::int AS n FROM pedido WHERE tenant_id = tenant_atual() GROUP BY estado`
      const segmentos = await distribuicaoRfv(tx)
      return { v30, clientes, pedidos, segmentos }
    })

    // Clientes que precisam de ação (segmentos de urgência alta).
    const urgentes = dados.segmentos
      .filter((s) => s.urgencia >= 70)
      .reduce((soma, s) => soma + s.contatos, 0)
    const porEstado = Object.fromEntries(dados.pedidos.map((p) => [p.estado, p.n]))

    return reply.send({
      vendas30d: {
        quantidade: dados.v30?.n ?? 0,
        totalCentavos: Number(dados.v30?.total ?? 0),
        ticketMedioCentavos: dados.v30?.ticket ? Number(dados.v30.ticket) : null,
      },
      clientesComHistorico: dados.clientes?.n ?? 0,
      clientesParaAgirHoje: urgentes,
      pedidos: {
        rascunhos: porEstado['rascunho'] ?? 0,
        efetivados: porEstado['efetivado'] ?? 0,
        falharam: porEstado['falhou'] ?? 0,
      },
    })
  })
}
