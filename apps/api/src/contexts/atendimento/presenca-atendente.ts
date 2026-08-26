import type { Sql } from '../../db/index.js'

/**
 * TEM GENTE ALI AGORA? — a régua de presença humana numa conversa.
 *
 * ⚠️ Mora aqui, sozinha, porque agora é usada em DOIS lugares: a resposta de
 * ausência e o agente SDR. Duas cópias do mesmo predicado divergem no primeiro
 * ajuste — e o sintoma seria o robô falando por cima de um atendente, ou
 * calando quando ninguém está. É o mesmo erro que produziu o alerta órfão e o
 * estado de canal sem carimbo nesta mesma semana.
 *
 * ⚠️ A pergunta NÃO é "existe atendimento aberto com atendente". Uma assunção
 * esquecida há catorze dias não é presença humana — foi assim que um cliente
 * escreveu e não recebeu nada (2026-08-26). Presença tem prazo.
 */
export const MINUTOS_DE_PRESENCA = 60

/**
 * Fragmento SQL booleano, para embutir num SELECT.
 *
 * ⚠️ Usa `tenant_atual()`, que vem do token (ADR-001) — nunca de parâmetro. Os
 * dois chamadores rodam sob `comTenantServico`, então o escopo já está posto.
 *
 * ⚠️ `enviada_por_id` é o que separa pessoa de sistema: disparo de campanha vai
 * sem autor, e sem esse filtro uma campanha enviada ao contato passaria por
 * atendente presente e calaria o produto por uma hora.
 */
export function fragmentoAtendentePresente(sql: Sql, conversaId: string, agora: Date) {
  return sql`
    EXISTS (SELECT 1 FROM atendimento a
             WHERE a.tenant_id = tenant_atual() AND a.conversa_id = ${conversaId}
               AND a.estado <> 'encerrado' AND a.atendente_id IS NOT NULL
               AND (
                 a.assumido_em > ${agora}::timestamptz
                                 - make_interval(mins => ${MINUTOS_DE_PRESENCA})
                 OR EXISTS (SELECT 1 FROM mensagem m
                             WHERE m.tenant_id = tenant_atual()
                               AND m.conversa_id = ${conversaId}
                               AND m.direcao = 'saliente'
                               AND m.enviada_por_id IS NOT NULL
                               AND m.criado_em > ${agora}::timestamptz
                                   - make_interval(mins => ${MINUTOS_DE_PRESENCA}))
               ))`
}
