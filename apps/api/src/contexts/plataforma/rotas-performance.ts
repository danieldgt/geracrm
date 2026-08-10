import type { FastifyInstance } from 'fastify'
import { exigirTenant } from '../../plugins/tenant.js'

/**
 * Performance de atendimento — SLA e 1ª resposta, agregados sobre `atendimento`
 * (0012). ⚠️ Os marcos já estão gravados na linha (primeira_resposta_humana_em,
 * assumido_em…): nada de varrer `mensagem` particionada.
 *
 * ⚠️ Tempo de 1ª resposta usa `primeira_resposta_humana_em`, NÃO a automática —
 * a decisão de duas colunas em 0012 existe justamente para o "Recebemos sua
 * mensagem!" não declarar uma vitória de SLA que não houve.
 *
 * O SLA (minutos) é um limiar de leitura declarado aqui e devolvido no payload,
 * para a tela mostrar contra o quê o "% dentro do SLA" foi medido.
 */
const DIAS_VALIDOS = new Set([7, 30, 90])
const SLA_MINUTOS = 5 // limiar de "resposta rápida" — declarado, não escondido.

export async function rotasPerformance(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { dias?: string } }>(
    '/v1/performance', { preHandler: exigirTenant },
    async (req, reply) => {
      const dias = DIAS_VALIDOS.has(Number(req.query.dias)) ? Number(req.query.dias) : 30
      const dados = await req.comTenant(async (tx) => {
        const desde = tx`now() - (${dias} || ' days')::interval`

        // Segundos até a 1ª resposta HUMANA, a partir da chegada (primeira_entrante_em).
        const [geral] = await tx<{
          total: number; assumidos: number; respondidos: number; dentro_sla: number
          mediana_seg: number | null
        }[]>`
          SELECT count(*)::int AS total,
                 count(*) FILTER (WHERE assumido_em IS NOT NULL)::int AS assumidos,
                 count(*) FILTER (WHERE primeira_resposta_humana_em IS NOT NULL)::int AS respondidos,
                 count(*) FILTER (
                   WHERE primeira_resposta_humana_em IS NOT NULL AND primeira_entrante_em IS NOT NULL
                     AND primeira_resposta_humana_em - primeira_entrante_em <= (${SLA_MINUTOS} || ' minutes')::interval
                 )::int AS dentro_sla,
                 percentile_cont(0.5) WITHIN GROUP (
                   ORDER BY EXTRACT(EPOCH FROM (primeira_resposta_humana_em - primeira_entrante_em))
                 ) FILTER (WHERE primeira_resposta_humana_em IS NOT NULL AND primeira_entrante_em IS NOT NULL)
                   AS mediana_seg
            FROM atendimento
           WHERE tenant_id = tenant_atual() AND criado_em >= ${desde}`

        const porAtendente = await tx<{
          usuario_id: string | null; nome: string | null; respondidos: number; mediana_seg: number | null
        }[]>`
          SELECT primeira_resposta_por_id AS usuario_id, u.nome,
                 count(*)::int AS respondidos,
                 percentile_cont(0.5) WITHIN GROUP (
                   ORDER BY EXTRACT(EPOCH FROM (primeira_resposta_humana_em - primeira_entrante_em))
                 ) AS mediana_seg
            FROM atendimento a
            LEFT JOIN usuario u ON u.tenant_id = a.tenant_id AND u.id = a.primeira_resposta_por_id
           WHERE a.tenant_id = tenant_atual() AND a.criado_em >= ${desde}
             AND a.primeira_resposta_humana_em IS NOT NULL AND a.primeira_entrante_em IS NOT NULL
             AND a.primeira_resposta_por_id IS NOT NULL
           GROUP BY a.primeira_resposta_por_id, u.nome
           ORDER BY count(*) DESC LIMIT 10`

        return { geral, porAtendente }
      })

      const g = dados.geral
      return reply.send({
        dias,
        slaMinutos: SLA_MINUTOS,
        total: g?.total ?? 0,
        assumidos: g?.assumidos ?? 0,
        respondidos: g?.respondidos ?? 0,
        dentroSla: g?.dentro_sla ?? 0,
        pctDentroSla: g?.respondidos ? Math.round(((g.dentro_sla) / g.respondidos) * 100) : null,
        medianaRespostaSeg: g?.mediana_seg !== null && g?.mediana_seg !== undefined ? Math.round(g.mediana_seg) : null,
        porAtendente: dados.porAtendente.map((r) => ({
          usuarioId: r.usuario_id, nome: r.nome ?? 'Desconhecido',
          respondidos: r.respondidos,
          medianaRespostaSeg: r.mediana_seg !== null ? Math.round(r.mediana_seg) : null,
        })),
      })
    },
  )
}
