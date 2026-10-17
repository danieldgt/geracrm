import type { FastifyInstance } from 'fastify'
import type { MetricaSlaHandoff } from '@geracrm/shared'
import { exigirTenant } from '../../plugins/tenant.js'
import { respostaHumanaDoAtendimento } from '../atendimento/sla-handoff.js'

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
 *
 * P18 (SLA do handoff, ADR-034): quando o tenant CONFIGUROU o SLA em algum
 * número (`atendimento_sla_config`), o "% dentro do SLA" passa a ser o SLA
 * CUMPRIDO dos handoffs — resposta humana até `sla_vence_em`, em minutos
 * ÚTEIS — e substitui o limiar fixo de 5 min (`slaFonte: 'handoff'`). Sem
 * configuração, o fixo continua (`slaFonte: 'fixo'`); o bloco `slaHandoff`
 * vem sempre, porque o SLA padrão (30 min úteis) mede os handoffs de todo jeito.
 *
 *   medidos  = handoffs com SLA decidido: respondidos (no prazo ou não) ou estourados;
 *   cumpridos = resposta humana até `sla_vence_em`.
 * Pendentes (ainda no prazo, sem resposta) não entram — não estão decididos.
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

        // ⚠️ A resposta é medida NA CONSULTA (`respostaHumanaDoAtendimento`), não só
        //    pelo carimbo do worker: cobre o encerrado antes da passada e o
        //    respondido nos últimos 30 s. Sem resposta e com o prazo vencido conta
        //    como estourado mesmo que o worker não tenha passado (encerrado depois do prazo).
        const [handoff] = await tx<{ medidos: number; cumpridos: number; estourados: number; pendentes: number; respondidos: number }[]>`
          SELECT count(*) FILTER (WHERE resp IS NOT NULL OR estourado_em IS NOT NULL OR vence <= now())::int AS medidos,
                 count(*) FILTER (WHERE resp IS NOT NULL AND resp <= vence)::int AS cumpridos,
                 count(*) FILTER (WHERE (resp IS NOT NULL AND resp > vence)
                                     OR (resp IS NULL AND (estourado_em IS NOT NULL OR vence <= now())))::int AS estourados,
                 count(*) FILTER (WHERE resp IS NULL AND estourado_em IS NULL AND vence > now() AND estado <> 'encerrado')::int AS pendentes,
                 count(*) FILTER (WHERE resp IS NOT NULL)::int AS respondidos
            FROM (SELECT a.sla_vence_em AS vence, a.sla_estourado_em AS estourado_em, a.estado,
                         coalesce(a.sla_respondido_em, ${respostaHumanaDoAtendimento(tx)}) AS resp
                    FROM atendimento a
                   WHERE a.tenant_id = tenant_atual() AND a.sla_vence_em IS NOT NULL AND a.sla_inicio_em >= ${desde}) s`
        const [cfg] = await tx<{ n: number; min: number | null; max: number | null }[]>`
          SELECT count(*)::int AS n, min(sla_minutos) AS min, max(sla_minutos) AS max
            FROM atendimento_sla_config WHERE tenant_id = tenant_atual()`
        return { geral, porAtendente, handoff, cfg }
      })

      const g = dados.geral
      const h = dados.handoff
      const slaHandoff: MetricaSlaHandoff = {
        medidos: h?.medidos ?? 0, cumpridos: h?.cumpridos ?? 0, estourados: h?.estourados ?? 0, pendentes: h?.pendentes ?? 0,
        respondidos: h?.respondidos ?? 0,
        pctCumprido: h?.medidos ? Math.round((h.cumpridos / h.medidos) * 100) : null,
      }
      const configurado = (dados.cfg?.n ?? 0) > 0
      return reply.send({
        dias,
        slaFonte: configurado ? 'handoff' : 'fixo',
        // Configurado: o MENOR SLA entre os números (minutos ÚTEIS); `slaMinutosVariam` diz se há números diferentes.
        slaMinutos: configurado ? (dados.cfg?.min ?? SLA_MINUTOS) : SLA_MINUTOS,
        slaMinutosVariam: configurado && dados.cfg?.min !== dados.cfg?.max,
        total: g?.total ?? 0,
        assumidos: g?.assumidos ?? 0,
        // Configurado: `respondidos` é a BASE do SLA (handoffs decididos), para que
        // dentroSla / respondidos = pctDentroSla. A contagem geral vai em `respondidosPorGente`.
        respondidos: configurado ? slaHandoff.medidos : g?.respondidos ?? 0,
        respondidosPorGente: g?.respondidos ?? 0,
        dentroSla: configurado ? slaHandoff.cumpridos : g?.dentro_sla ?? 0,
        pctDentroSla: configurado ? slaHandoff.pctCumprido
          : g?.respondidos ? Math.round(((g.dentro_sla) / g.respondidos) * 100) : null,
        slaHandoff,
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
