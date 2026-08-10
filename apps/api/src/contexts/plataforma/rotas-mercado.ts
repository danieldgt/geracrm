import type { FastifyInstance } from 'fastify'
import { exigirTenant } from '../../plugins/tenant.js'
import { distribuicaoRfv } from '../crm/rotas-segmentos.js'

/**
 * Visão de Mercado — a fotografia da BASE: tamanho, de onde os contatos vieram,
 * o quanto ela é acionável (WhatsApp, telefone, opt-out) e onde ela está no RFV.
 * ⚠️ Leitura pura sobre o cadastro; a régua RFV é a MESMA `distribuicaoRfv` do
 * resto (shared), a tela não reinventa fronteira. Só contatos ATIVOS.
 */
export async function rotasMercado(app: FastifyInstance): Promise<void> {
  app.get('/v1/mercado', { preHandler: exigirTenant }, async (req, reply) => {
    const dados = await req.comTenant(async (tx) => {
      const [cob] = await tx<{
        total: number; com_whatsapp: number; com_telefone: number; com_erp: number
        opt_out: number; ja_compraram: number
      }[]>`
        SELECT
          count(*)::int AS total,
          count(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM contato_telefone t WHERE t.tenant_id = c.tenant_id AND t.contato_id = c.id AND t.whatsapp))::int AS com_whatsapp,
          count(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM contato_telefone t WHERE t.tenant_id = c.tenant_id AND t.contato_id = c.id))::int AS com_telefone,
          count(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM contato_identidade_externa e WHERE e.tenant_id = c.tenant_id AND e.contato_id = c.id))::int AS com_erp,
          count(*) FILTER (WHERE NOT recebe_campanhas)::int AS opt_out,
          count(*) FILTER (WHERE qtd_vendas > 0)::int AS ja_compraram
        FROM contato c
        WHERE c.tenant_id = tenant_atual() AND c.ativo`

      const porOrigem = await tx<{ origem: string; contatos: number }[]>`
        SELECT COALESCE(NULLIF(origem_carga, ''), 'não informado') AS origem, count(*)::int AS contatos
          FROM contato
         WHERE tenant_id = tenant_atual() AND ativo
         GROUP BY COALESCE(NULLIF(origem_carga, ''), 'não informado')
         ORDER BY count(*) DESC LIMIT 12`

      const rfv = await distribuicaoRfv(tx)
      return { cob, porOrigem, rfv }
    })

    const c = dados.cob
    return reply.send({
      total: c?.total ?? 0,
      cobertura: {
        comWhatsapp: c?.com_whatsapp ?? 0,
        comTelefone: c?.com_telefone ?? 0,
        comErp: c?.com_erp ?? 0,
        optOut: c?.opt_out ?? 0,
        jaCompraram: c?.ja_compraram ?? 0,
      },
      porOrigem: dados.porOrigem.map((o) => ({ origem: o.origem, contatos: o.contatos })),
      rfv: dados.rfv.map((s) => ({ codigo: s.codigo, rotulo: s.rotulo, urgencia: s.urgencia, contatos: s.contatos })),
    })
  })
}
