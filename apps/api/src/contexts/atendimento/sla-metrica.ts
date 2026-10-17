import type { MetricaSlaHandoff } from '@geracrm/shared'
import type { Sql } from '../../db/index.js'
import { respostaHumanaDoAtendimento } from './sla-handoff.js'

/**
 * O SLA DO HANDOFF medido (P18, ADR-034) — UMA régua para `/v1/performance`
 * (o tenant inteiro) e para o painel de fase do agente (P19, um número).
 *
 *   medidos    = handoffs com SLA decidido: respondidos (no prazo ou não) ou estourados;
 *   cumpridos  = resposta humana até `sla_vence_em`;
 *   estourados = respondidos depois do prazo, ou sem resposta com o prazo vencido;
 *   pendentes  = ainda no prazo, sem resposta (não entram em `medidos`);
 *   pctCumprido = cumpridos ÷ medidos em % INTEIRO (o contrato da P18).
 *
 * ⚠️ Quem decide um limiar compara `cumpridos / medidos` — o percentual
 *    arredondado transforma 89,6% em 90%.
 * ⚠️ A resposta é medida NA CONSULTA (`respostaHumanaDoAtendimento`), não só
 *    pelo carimbo do worker: cobre o encerrado antes da passada e o respondido
 *    nos últimos 30 s. Sem resposta e com o prazo vencido conta como estourado
 *    mesmo que o worker não tenha passado.
 * Sob RLS do tenant (tx de `req.comTenant`).
 */
export async function metricaSlaHandoff(tx: Sql, p: { readonly desde: Date; readonly canalId?: string | null }): Promise<MetricaSlaHandoff> {
  const [h] = await tx<{ medidos: number; cumpridos: number; estourados: number; pendentes: number; respondidos: number }[]>`
    SELECT count(*) FILTER (WHERE resp IS NOT NULL OR estourado_em IS NOT NULL OR vence <= now())::int AS medidos,
           count(*) FILTER (WHERE resp IS NOT NULL AND resp <= vence)::int AS cumpridos,
           count(*) FILTER (WHERE (resp IS NOT NULL AND resp > vence)
                               OR (resp IS NULL AND (estourado_em IS NOT NULL OR vence <= now())))::int AS estourados,
           count(*) FILTER (WHERE resp IS NULL AND estourado_em IS NULL AND vence > now() AND estado <> 'encerrado')::int AS pendentes,
           count(*) FILTER (WHERE resp IS NOT NULL)::int AS respondidos
      FROM (SELECT a.sla_vence_em AS vence, a.sla_estourado_em AS estourado_em, a.estado,
                   coalesce(a.sla_respondido_em, ${respostaHumanaDoAtendimento(tx)}) AS resp
              FROM atendimento a
             WHERE a.tenant_id = tenant_atual() AND a.sla_vence_em IS NOT NULL AND a.sla_inicio_em >= ${p.desde}
               ${p.canalId ? tx`AND a.canal_id = ${p.canalId}` : tx``}) s`
  const m = {
    medidos: h?.medidos ?? 0, cumpridos: h?.cumpridos ?? 0, estourados: h?.estourados ?? 0,
    pendentes: h?.pendentes ?? 0, respondidos: h?.respondidos ?? 0,
  }
  return { ...m, pctCumprido: m.medidos ? Math.round((m.cumpridos / m.medidos) * 100) : null }
}
