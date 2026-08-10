import type { FastifyInstance } from 'fastify'
import { exigirTenant } from '../../plugins/tenant.js'

/**
 * Fidelidade / Cashback — leitura do saldo LIDO do ERP (ADR-020). A alavancagem
 * é nossa (mostrar, segmentar); o saldo, não.
 *
 * ⚠️ Degradação honesta (ADR-008): sem um conector que declare a capacidade
 * `fidelidade`, o painel devolve `disponivel:false` com o motivo — a tela some
 * com os blocos e explica, em vez de mostrar número inventado. Quando um ERP com
 * a capacidade sincronizar, os saldos aparecem sozinhos.
 */
export async function rotasFidelidade(app: FastifyInstance): Promise<void> {
  app.get('/v1/fidelidade', { preHandler: exigirTenant }, async (req, reply) => {
    const dados = await req.comTenant(async (tx) => {
      const [cap] = await tx<{ tem_conector: boolean; tem_fidelidade: boolean }[]>`
        SELECT
          EXISTS (SELECT 1 FROM conexao_erp WHERE tenant_id = tenant_atual()) AS tem_conector,
          EXISTS (SELECT 1 FROM conexao_erp
                   WHERE tenant_id = tenant_atual() AND (capacidades->>'fidelidade')::boolean IS TRUE) AS tem_fidelidade
      `
      if (!cap?.tem_fidelidade) return { cap }
      const [resumo] = await tx<{ com_saldo: number; total: string; unidade: string | null; atualizado_em: Date | null }[]>`
        SELECT count(*) FILTER (WHERE saldo > 0)::int AS com_saldo,
               COALESCE(sum(saldo) FILTER (WHERE saldo > 0), 0)::text AS total,
               max(unidade) AS unidade,
               max(atualizado_em) AS atualizado_em
          FROM fidelidade_saldo WHERE tenant_id = tenant_atual()`
      const top = await tx<{ contato_id: string; contato: string; saldo: string; unidade: string }[]>`
        SELECT f.contato_id, c.nome AS contato, f.saldo::text AS saldo, f.unidade
          FROM fidelidade_saldo f
          JOIN contato c ON c.tenant_id = f.tenant_id AND c.id = f.contato_id
         WHERE f.tenant_id = tenant_atual() AND f.saldo > 0
         ORDER BY f.saldo DESC LIMIT 10`
      return { cap, resumo, top }
    })

    if (!dados.cap?.tem_fidelidade) {
      return reply.send({
        disponivel: false,
        motivo: dados.cap?.tem_conector ? 'erp_sem_fidelidade' : 'sem_conector',
      })
    }
    const r = dados.resumo
    return reply.send({
      disponivel: true,
      resumo: {
        clientesComSaldo: r?.com_saldo ?? 0,
        totalSaldo: Number(r?.total ?? 0),
        unidade: r?.unidade ?? 'centavos',
        sincronizadoEm: r?.atualizado_em ?? null,
      },
      topSaldos: (dados.top ?? []).map((t) => ({
        contatoId: t.contato_id, contato: t.contato, saldo: Number(t.saldo), unidade: t.unidade,
      })),
    })
  })

  // Saldo de UM contato (para a ficha). null quando não há saldo/indisponível.
  app.get<{ Params: { id: string } }>(
    '/v1/contatos/:id/fidelidade', { preHandler: exigirTenant },
    async (req, reply) => {
      const dados = await req.comTenant(async (tx) => {
        const [cap] = await tx<{ tem: boolean }[]>`
          SELECT EXISTS (SELECT 1 FROM conexao_erp
                          WHERE tenant_id = tenant_atual() AND (capacidades->>'fidelidade')::boolean IS TRUE) AS tem`
        if (!cap?.tem) return { disponivel: false as const }
        const [s] = await tx<{ saldo: string; unidade: string; atualizado_em: Date }[]>`
          SELECT saldo::text AS saldo, unidade, atualizado_em
            FROM fidelidade_saldo WHERE tenant_id = tenant_atual() AND contato_id = ${req.params.id}`
        return { disponivel: true as const, s }
      })
      if (!dados.disponivel) return reply.send({ disponivel: false })
      return reply.send({
        disponivel: true,
        saldo: dados.s ? Number(dados.s.saldo) : 0,
        unidade: dados.s?.unidade ?? 'centavos',
        sincronizadoEm: dados.s?.atualizado_em ?? null,
      })
    },
  )
}
