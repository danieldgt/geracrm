import type { Sql } from '../../db/index.js'

/**
 * MARCO DA 1ª RESPOSTA HUMANA do atendimento aberto (0012, MO-07/MC-05) — a métrica fixa
 * de 5 min da performance (`rotas-performance.ts`) lê estas colunas.
 *
 * Chamada sob o tenant (`tenant_atual()`), DEPOIS de um envio que saiu (gateway ok), com o
 * id da mensagem. A régua de "resposta de GENTE" é a da P18 (`respostaHumanaDoAtendimento`):
 * mensagem saliente com `enviada_por_id` — o agente, a ausência, a automação e a campanha
 * não têm autor e não contam. Vale para todo caminho de envio humano que grava o autor
 * (resposta digitada, resumo de proposta enviado pelo vendedor).
 *
 *   - `primeira_resposta_humana_em` / `primeira_resposta_por_id`: o `criado_em` e o autor da
 *     PRÓPRIA mensagem (um só relógio — o do banco, que carimbou a mensagem);
 *   - `primeira_resposta_em` (qualquer resposta): fica a anterior, se a automática já veio;
 *   - `primeira_entrante_em`: se ninguém marcou, a 1ª entrante da conversa depois do fim do
 *     atendimento anterior e antes desta resposta — a chegada que este atendimento atende.
 *
 * Idempotente: só o primeiro envio conta (`primeira_resposta_humana_em IS NULL`). Sem
 * atendimento aberto, ou mensagem sem autor, nada a marcar.
 */
export async function marcarPrimeiraRespostaHumana(
  tx: Sql, p: { readonly conversaId: string; readonly mensagemId: string },
): Promise<boolean> {
  const r = await tx`
    UPDATE atendimento a
       SET primeira_resposta_humana_em = m.criado_em,
           primeira_resposta_por_id    = m.enviada_por_id,
           primeira_resposta_em        = coalesce(a.primeira_resposta_em, m.criado_em),
           primeira_entrante_em        = coalesce(a.primeira_entrante_em, (
             SELECT min(e.criado_em) FROM mensagem e
              WHERE e.tenant_id = a.tenant_id AND e.conversa_id = a.conversa_id AND e.direcao = 'entrante'
                AND e.criado_em <= m.criado_em
                AND e.criado_em > coalesce((SELECT max(ant.encerrado_em) FROM atendimento ant
                                             WHERE ant.tenant_id = a.tenant_id AND ant.conversa_id = a.conversa_id
                                               AND ant.id <> a.id AND ant.encerrado_em IS NOT NULL),
                                           '-infinity'::timestamptz)))
      FROM mensagem m
     WHERE m.tenant_id = tenant_atual() AND m.id = ${p.mensagemId} AND m.conversa_id = ${p.conversaId}
       AND m.direcao = 'saliente' AND m.enviada_por_id IS NOT NULL
       AND a.tenant_id = tenant_atual() AND a.conversa_id = m.conversa_id
       AND a.estado <> 'encerrado' AND a.primeira_resposta_humana_em IS NULL`
  return r.count > 0
}
