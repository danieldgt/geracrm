import type { FastifyInstance } from 'fastify'
import { exigirTenant } from '../../plugins/tenant.js'
import { latenciaMedia } from './latencia.js'

/** Painel de sincronização (INT-08) — o que cada fluxo trouxe e rejeitou. */
export async function rotasSync(app: FastifyInstance): Promise<void> {
  app.get('/v1/integracao/operacoes', { preHandler: exigirTenant }, async (req, reply) => {
    const linhas = await req.comTenant((tx) => tx<{
      fluxo: string; origem: string; iniciado_em: Date; concluido_em: Date | null
      total: number; aceitos: number; rejeitados: number; estado: string
    }[]>`
      SELECT fluxo, origem, iniciado_em, concluido_em, total, aceitos, rejeitados, estado
        FROM operacao_ingestao
       WHERE tenant_id = tenant_atual()
       ORDER BY iniciado_em DESC
       LIMIT 30`)
    return reply.send({
      itens: linhas.map((l) => ({
        fluxo: l.fluxo, origem: l.origem, iniciadoEm: l.iniciado_em, concluidoEm: l.concluido_em,
        total: l.total, aceitos: l.aceitos, rejeitados: l.rejeitados, estado: l.estado,
      })),
    })
  })

  /** Latência média do conector por chamada (Onda 2). */
  app.get('/v1/integracao/latencia', { preHandler: exigirTenant }, async (req, reply) => {
    const itens = await req.comTenant((tx) => latenciaMedia(tx))
    return reply.send({ itens })
  })
}
