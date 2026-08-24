import type { Sql } from '../../db/index.js'

/**
 * RESOLUÇÃO TARDIA DA ORIGEM — casar o lead com a estrutura de anúncio que só
 * chega depois.
 *
 * ⚠️ O descompasso é estrutural, não um defeito: o lead entra pelo webhook em
 * **segundos**, com o id do anúncio como TEXTO; a estrutura de veiculação só
 * chega na sincronização seguinte, **horas depois**. Por isso `midia_lead_origem`
 * guarda `anuncio_externo_id` sempre e as FKs ficam nulas até aqui (migration
 * 0059). Um desenho só-FK perderia justamente os leads mais recentes — os que
 * mais importam.
 *
 * Roda depois de cada sincronização de estrutura, em modo DONO (worker), com o
 * `tenant_id` explícito — igual ao `automacao-motor` e ao despachante de webhooks.
 */

export interface ResultadoResolucao {
  /** Casaram com exatamente um anúncio e foram preenchidas. */
  readonly resolvidas: number
  /**
   * ⚠️ Casaram com MAIS DE UM anúncio e foram deixadas em paz. Ver por que abaixo.
   */
  readonly ambiguas: number
  /** Continuam sem correspondente — o anúncio ainda não sincronizou, ou nunca vai. */
  readonly pendentes: number
}

/**
 * ⚠️ Janela de tentativa. Origem mais velha que isto para de ser varrida: se o
 * anúncio não apareceu em 30 dias, ele não vai aparecer — foi apagado, veio de
 * outra conta, ou o id chegou errado. Sem o corte, a varredura arrasta para
 * sempre um resíduo que nunca resolve.
 *
 * A origem antiga não é perdida: ela permanece com `anuncio_externo_id`
 * preenchido e vale como **origem parcial** (sabemos que veio de anúncio, não de
 * qual).
 */
const DIAS_DE_TENTATIVA = 30

/**
 * Preenche `anuncio_id`, `campanha_id` e `conta_id` das origens pendentes.
 *
 * ⚠️ **Idempotente**: só toca linhas com `anuncio_id IS NULL`. Rodar duas vezes
 * seguidas não muda nada na segunda.
 *
 * ⚠️ **Nunca adivinha.** `midia_anuncio.id_externo` é único por CONJUNTO, não por
 * tenant — dois conjuntos podem, em tese, ter anúncios com o mesmo id externo. Se
 * houver mais de um candidato, a linha fica pendente em vez de ser atribuída ao
 * primeiro que aparecer: creditar a venda ao anúncio errado é pior do que não
 * creditar, porque o número fica plausível e ninguém desconfia. É a mesma regra
 * de `extrairCodigoOrigem`.
 */
export async function resolverOrigensPendentes(sql: Sql, tenantId: string): Promise<ResultadoResolucao> {
  const [resolvidas] = await sql<{ n: number }[]>`
    WITH hierarquia AS (
      SELECT a.tenant_id, a.id_externo, a.id AS anuncio_id,
             cj.campanha_id, c.conta_id
        FROM midia_anuncio  a
        JOIN midia_conjunto cj ON cj.tenant_id = a.tenant_id  AND cj.id = a.conjunto_id
        JOIN midia_campanha c  ON c.tenant_id  = cj.tenant_id AND c.id  = cj.campanha_id
       WHERE a.tenant_id = ${tenantId}
    ),
    -- ⚠️ Um id externo que aponta para mais de um anúncio é ambíguo e fica de fora.
    inequivocas AS (
      SELECT id_externo FROM hierarquia GROUP BY id_externo HAVING count(*) = 1
    )
    UPDATE midia_lead_origem o
       SET anuncio_id  = h.anuncio_id,
           campanha_id = h.campanha_id,
           conta_id    = h.conta_id
      FROM hierarquia h
      JOIN inequivocas u ON u.id_externo = h.id_externo
     WHERE o.tenant_id = ${tenantId}
       AND o.anuncio_id IS NULL
       AND o.anuncio_externo_id = h.id_externo
       AND o.capturado_em > now() - make_interval(days => ${DIAS_DE_TENTATIVA})
    RETURNING 1 AS n`
      .then((linhas) => [{ n: linhas.length }])

  const [contagem] = await sql<{ ambiguas: number; pendentes: number }[]>`
    WITH pendentes AS (
      SELECT o.anuncio_externo_id
        FROM midia_lead_origem o
       WHERE o.tenant_id = ${tenantId}
         AND o.anuncio_id IS NULL
         AND o.anuncio_externo_id IS NOT NULL
         AND o.capturado_em > now() - make_interval(days => ${DIAS_DE_TENTATIVA})
    )
    SELECT
      count(*) FILTER (WHERE (
        SELECT count(*) FROM midia_anuncio a
         WHERE a.tenant_id = ${tenantId} AND a.id_externo = p.anuncio_externo_id) > 1
      )::int AS ambiguas,
      count(*)::int AS pendentes
      FROM pendentes p`

  return {
    resolvidas: resolvidas?.n ?? 0,
    ambiguas: contagem?.ambiguas ?? 0,
    pendentes: contagem?.pendentes ?? 0,
  }
}
