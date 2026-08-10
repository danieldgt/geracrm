import type { FastifyInstance } from 'fastify'
import { exigirTenant } from '../../plugins/tenant.js'

/**
 * Leitura de métricas (I-11) e alertas (I-10). Sob RLS: cada tenant só vê o seu.
 */
export async function rotasMetricas(app: FastifyInstance): Promise<void> {
  /** Série de uma métrica por hora, janela recente (padrão 24h). */
  app.get<{ Params: { metrica: string }; Querystring: { horas?: string } }>(
    '/v1/metricas/:metrica',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const horas = Math.min(Math.max(Number(req.query.horas) || 24, 1), 168)
      const linhas = await req.comTenant((tx) => tx<{ bucket: Date; valor: string }[]>`
        SELECT bucket, valor::text AS valor
          FROM metrica_janela
         WHERE tenant_id = tenant_atual() AND metrica = ${req.params.metrica}
           AND bucket >= date_trunc('hour', now()) - make_interval(hours => ${horas})
         ORDER BY bucket ASC`)
      return reply.send({
        metrica: req.params.metrica,
        pontos: linhas.map((l) => ({ bucket: l.bucket, valor: Number(l.valor) })),
      })
    },
  )

  /** Alertas — por padrão só os ABERTOS (o que exige ação agora). */
  app.get<{ Querystring: { todos?: string } }>(
    '/v1/alertas',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const todos = req.query.todos === 'true'
      const linhas = await req.comTenant((tx) => tx<{
        id: string; tipo: string; severidade: string; mensagem: string
        criado_em: Date; resolvido_em: Date | null
      }[]>`
        SELECT id, tipo, severidade, mensagem, criado_em, resolvido_em
          FROM alerta
         WHERE tenant_id = tenant_atual()
           AND ${todos ? tx`true` : tx`resolvido_em IS NULL`}
         ORDER BY criado_em DESC LIMIT 50`)
      return reply.send({
        itens: linhas.map((l) => ({
          id: l.id, tipo: l.tipo, severidade: l.severidade, mensagem: l.mensagem,
          criadoEm: l.criado_em, resolvido: l.resolvido_em !== null,
        })),
      })
    },
  )
}
