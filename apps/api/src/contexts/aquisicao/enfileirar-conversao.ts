import type { Sql } from '../../db/index.js'
import { DIAS_JANELA_IMPORTACAO } from './despachante-conversao.js'

/**
 * ENFILEIRADOR DE CONVERSÕES (AQ-15) — transforma venda efetivada no ERP em
 * conversão a devolver.
 *
 * É o elo que fecha o loop: a venda existe no ERP porque o conector a importou;
 * a origem existe porque o lead entrou por um anúncio; aqui os dois se encontram.
 *
 * ⚠️ Roda como DONO (worker), com `tenant_id` explícito — igual ao despachante.
 */

/**
 * ⚠️ **Uma conversão POR PLATAFORMA por venda**, cada uma com o `click_id` do
 * último toque *daquela* plataforma antes da venda.
 *
 * O motivo é que **a atribuição final é da plataforma, não nossa**: ela casa o
 * `click_id`, aplica a própria janela e decide se credita. Nosso trabalho é
 * entregar o fato com o identificador certo — não escolher quem leva o crédito.
 *
 * É por isso que o modelo de atribuição do ROI (`roi.ts`, primeiro × último
 * toque) **não se aplica aqui**: lá respondemos ao cliente com um número nosso;
 * aqui alimentamos o algoritmo com um fato. Confundir os dois faria a plataforma
 * receber a nossa opinião em vez do dado.
 */
export interface ResultadoEnfileiramento {
  readonly criadas: number
  /** Já existiam — o índice único (INV-62) as barrou. Rodar de novo é seguro. */
  readonly jaExistiam: number
}

/**
 * Cria as conversões pendentes das vendas do período.
 *
 * ⚠️ **Idempotente por `ON CONFLICT DO NOTHING`** sobre `midia_conversao_venda_unica`
 * (INV-62). Chamar duas vezes não duplica — o que importa porque isto roda a cada
 * importação do ERP, e importação repetida é normal.
 */
export async function enfileirarConversoesDeVendas(
  sql: Sql, tenantId: string, agora: Date,
): Promise<ResultadoEnfileiramento> {
  const inicioJanela = new Date(agora.getTime() - DIAS_JANELA_IMPORTACAO * 86_400_000)

  const criadas = await sql<{ id: string }[]>`
    INSERT INTO midia_conversao
      (tenant_id, id, venda_id, venda_ocorrida_em, origem_id, plataforma,
       tipo_evento, valor_centavos, event_id, proxima_tentativa_em)
    SELECT v.tenant_id,
           gen_random_uuid(),
           v.id,
           v.ocorrida_em,
           toque.id,
           toque.plataforma,
           'compra',
           v.valor_centavos,
           -- ⚠️ "event_id" DETERMINÍSTICO: derivado da venda, da plataforma e do
           --    tipo. Um id aleatório faria cada reprocessamento parecer um
           --    evento novo para a plataforma — e receita duplicada no painel
           --    dela é o erro que ninguém reclama, porque o número fica MAIOR.
           'v-' || v.id::text || '-' || toque.plataforma || '-compra',
           ${agora}
      FROM venda v
      JOIN LATERAL (
        -- ⚠️ DISTINCT ON por plataforma: o ÚLTIMO toque de CADA plataforma antes
        --    da venda. Sem o DISTINCT ON, um contato tocado por Google e Meta
        --    geraria conversão só para um dos dois, e metade do sinal se perderia.
        SELECT DISTINCT ON (o.plataforma) o.id, o.plataforma
          FROM midia_lead_origem o
         WHERE o.tenant_id = v.tenant_id
           AND o.contato_id = v.contato_id
           AND o.plataforma IS NOT NULL
           -- Sem identificador não há como a plataforma casar o evento.
           AND o.click_id IS NOT NULL
           AND o.capturado_em <= v.ocorrida_em
         ORDER BY o.plataforma, o.capturado_em DESC, o.id DESC
      ) toque ON true
     WHERE v.tenant_id = ${tenantId}
       AND v.contato_id IS NOT NULL
       -- ⚠️ Venda cancelada não é receita (convenção do repositório).
       AND v.cancelada_em IS NULL
       -- ⚠️ Limites ABSOLUTOS: "venda" é particionada por "ocorrida_em" e sem
       --    constante o planejador não poda partição.
       AND v.ocorrida_em >= ${inicioJanela}
       AND v.ocorrida_em <= ${agora}
    ON CONFLICT DO NOTHING
    RETURNING id`

  // Quantas eram elegíveis no período — a diferença já existia.
  const [elegiveis] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n
      FROM venda v
      JOIN LATERAL (
        SELECT DISTINCT ON (o.plataforma) o.id
          FROM midia_lead_origem o
         WHERE o.tenant_id = v.tenant_id AND o.contato_id = v.contato_id
           AND o.plataforma IS NOT NULL AND o.click_id IS NOT NULL
           AND o.capturado_em <= v.ocorrida_em
         ORDER BY o.plataforma, o.capturado_em DESC, o.id DESC
      ) toque ON true
     WHERE v.tenant_id = ${tenantId}
       AND v.contato_id IS NOT NULL
       AND v.cancelada_em IS NULL
       AND v.ocorrida_em >= ${inicioJanela}
       AND v.ocorrida_em <= ${agora}`

  return {
    criadas: criadas.length,
    jaExistiam: Math.max(0, (elegiveis?.n ?? 0) - criadas.length),
  }
}
