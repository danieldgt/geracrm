import type { Sql } from '../../db/index.js'

/**
 * MARCO DA 1ª RESPOSTA HUMANA do atendimento aberto (0012, MO-07/MC-05) — a métrica fixa
 * de 5 min da performance (`rotas-performance.ts`) lê só estas colunas.
 *
 * Chamada sob o tenant (`tenant_atual()`), DEPOIS de um envio humano que saiu (gateway ok).
 * Só o primeiro envio conta: `primeira_resposta_humana_em IS NULL` no WHERE torna a
 * chamada idempotente e corrida entre dois vendedores não troca o autor.
 *
 *   - `primeira_resposta_humana_em` / `primeira_resposta_por_id`: este envio, desta pessoa;
 *   - `primeira_resposta_em` (qualquer resposta): fica a anterior, se a automática já veio;
 *   - `primeira_entrante_em`: se ninguém marcou, a 1ª entrante da conversa DEPOIS do fim do
 *     atendimento anterior — a chegada que este atendimento atende. Sem ela a métrica não
 *     tem de onde medir.
 *
 * ⚠️ Mensagem automática (ausência) e do agente NÃO passam por aqui: preencher esta coluna
 *    com resposta de robô é exatamente a vitória falsa que a contra-métrica MC-05 existe
 *    para impedir. Sem atendimento aberto, nada a marcar.
 */
export async function marcarPrimeiraRespostaHumana(
  tx: Sql, p: { readonly conversaId: string; readonly usuarioId: string; readonly agora: Date },
): Promise<boolean> {
  const r = await tx`
    UPDATE atendimento a
       SET primeira_resposta_humana_em = ${p.agora},
           primeira_resposta_por_id    = ${p.usuarioId},
           primeira_resposta_em        = coalesce(a.primeira_resposta_em, ${p.agora}),
           primeira_entrante_em        = coalesce(a.primeira_entrante_em, (
             SELECT min(m.criado_em) FROM mensagem m
              WHERE m.tenant_id = a.tenant_id AND m.conversa_id = a.conversa_id AND m.direcao = 'entrante'
                AND m.criado_em <= ${p.agora}
                AND m.criado_em > coalesce((SELECT max(ant.encerrado_em) FROM atendimento ant
                                             WHERE ant.tenant_id = a.tenant_id AND ant.conversa_id = a.conversa_id
                                               AND ant.id <> a.id AND ant.encerrado_em IS NOT NULL),
                                           '-infinity'::timestamptz)))
     WHERE a.tenant_id = tenant_atual() AND a.conversa_id = ${p.conversaId}
       AND a.estado <> 'encerrado' AND a.primeira_resposta_humana_em IS NULL`
  return r.count > 0
}
