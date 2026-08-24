import { calcularRoas } from '@geracrm/shared'
import type { Sql } from '../../db/index.js'

/**
 * ROI de VEICULAÇÃO — quanto um anúncio custou e quanto ele fez faturar no ERP.
 * É a afirmação central do produto (AQ-16), e por isso a que mais precisa ser
 * honesta.
 *
 * ⚠️ **Aqui não existe "atribuição exata" no sentido de `campanha` (0036).** Um
 * pedido de disparo de WhatsApp NASCE vinculado à campanha — o vínculo é um fato
 * registrado no instante da criação. Uma venda de lead de anúncio acontece
 * semanas ou meses depois, e ligá-la ao anúncio é **sempre um modelo**. Chamar
 * isso de "exata" seria pegar emprestada uma credibilidade que o dado não tem.
 *
 * O que devolvemos, então, separado e rotulado (AMK-009):
 *
 * | Número | Natureza |
 * |---|---|
 * | custo, cliques, impressões | **fato** — veio da plataforma |
 * | leads | **fato** — a origem foi registrada na entrada |
 * | custo por lead | fato ÷ fato |
 * | receita atribuída | ⚠️ **modelo declarado** (primeiro × último toque) + janela |
 * | receita sem ambiguidade | o subconjunto onde os dois modelos CONCORDAM |
 */

/** ⚠️ Nunca implícito. Quem chama escolhe, e a tela mostra qual foi. */
export type ModeloAtribuicao = 'primeiro_toque' | 'ultimo_toque'

export interface RoiVeiculacao {
  readonly periodo: { readonly de: string; readonly ate: string }
  /** Fatos vindos da plataforma. */
  readonly custoCentavos: number
  readonly impressoes: number
  readonly cliques: number
  /** Fato nosso: leads com origem registrada neste anúncio, no período. */
  readonly leads: number
  /** Fato ÷ fato. `null` sem leads — dividir por zero viraria Infinity na tela. */
  readonly custoPorLeadCentavos: number | null
  readonly atribuicao: {
    readonly modelo: ModeloAtribuicao
    readonly janelaDias: number
    readonly vendas: number
    readonly receitaCentavos: number
    /** ⚠️ modelo ÷ fato. Só pode aparecer rotulado com o modelo e a janela. */
    readonly roas: number | null
  }
  /**
   * ⚠️ O subconjunto de vendas cujo contato teve **um único toque de mídia** —
   * onde primeiro e último toque são o mesmo, então o número **não depende da
   * escolha de modelo**.
   *
   * A distância entre este número e o atribuído mede **quanto do ROAS é artefato
   * de modelagem**. Perto: o número se sustenta. Longe: ele é uma escolha nossa,
   * e o cliente merece saber disso antes de assinar performance em cima.
   */
  readonly semAmbiguidade: {
    readonly vendas: number
    readonly receitaCentavos: number
    readonly roas: number | null
  }
}

export interface ConsultaRoi {
  readonly anuncioId: string
  /** `YYYY-MM-DD`, inclusivos. */
  readonly de: string
  readonly ate: string
  readonly janelaDias: number
  readonly modelo: ModeloAtribuicao
}

interface LinhaAtribuicao {
  vendas: number
  receita: string
  vendas_sem_ambiguidade: number
  receita_sem_ambiguidade: string
}

/**
 * ⚠️ `venda` é particionada por `ocorrida_em`. As duas consultas abaixo carregam
 * limites ABSOLUTOS de data (`de`, `ate + janela`) além da comparação relativa ao
 * toque — sem constante, o planejador não poda partição e a consulta varre a
 * tabela inteira.
 */
async function atribuirPorPrimeiroToque(
  sql: Sql, q: ConsultaRoi, ateMaisJanela: string,
): Promise<LinhaAtribuicao | undefined> {
  const [linha] = await sql<LinhaAtribuicao[]>`
    SELECT count(*)::int                                                        AS vendas,
           coalesce(sum(v.valor_centavos), 0)::text                             AS receita,
           count(*) FILTER (WHERE toques.n = 1)::int                            AS vendas_sem_ambiguidade,
           coalesce(sum(v.valor_centavos) FILTER (WHERE toques.n = 1), 0)::text AS receita_sem_ambiguidade
      FROM midia_lead_origem o
      JOIN venda v
        ON v.tenant_id = o.tenant_id AND v.contato_id = o.contato_id
      JOIN LATERAL (
        SELECT count(*)::int AS n FROM midia_lead_origem o2
         WHERE o2.tenant_id = o.tenant_id AND o2.contato_id = o.contato_id
      ) toques ON true
     WHERE o.tenant_id = tenant_atual()
       AND o.anuncio_id = ${q.anuncioId}
       AND o.primeira
       AND o.capturado_em >= ${q.de}::date
       AND o.capturado_em <  ${q.ate}::date + 1
       AND v.cancelada_em IS NULL
       AND v.ocorrida_em >= ${q.de}::date
       AND v.ocorrida_em <  ${ateMaisJanela}::date
       AND v.ocorrida_em >= o.capturado_em
       AND v.ocorrida_em <  o.capturado_em + make_interval(days => ${q.janelaDias})`
  return linha
}

async function atribuirPorUltimoToque(
  sql: Sql, q: ConsultaRoi, ateMaisJanela: string,
): Promise<LinhaAtribuicao | undefined> {
  const [linha] = await sql<LinhaAtribuicao[]>`
    SELECT count(*)::int                                                        AS vendas,
           coalesce(sum(v.valor_centavos), 0)::text                             AS receita,
           count(*) FILTER (WHERE toques.n = 1)::int                            AS vendas_sem_ambiguidade,
           coalesce(sum(v.valor_centavos) FILTER (WHERE toques.n = 1), 0)::text AS receita_sem_ambiguidade
      FROM venda v
      JOIN LATERAL (
        SELECT o.anuncio_id, o.capturado_em
          FROM midia_lead_origem o
         WHERE o.tenant_id = v.tenant_id AND o.contato_id = v.contato_id
           AND o.capturado_em <= v.ocorrida_em
         ORDER BY o.capturado_em DESC, o.id DESC
         LIMIT 1
      ) ultimo ON true
      JOIN LATERAL (
        SELECT count(*)::int AS n FROM midia_lead_origem o2
         WHERE o2.tenant_id = v.tenant_id AND o2.contato_id = v.contato_id
      ) toques ON true
     WHERE v.tenant_id = tenant_atual()
       AND v.cancelada_em IS NULL
       AND v.ocorrida_em >= ${q.de}::date
       AND v.ocorrida_em <  ${ateMaisJanela}::date
       AND ultimo.anuncio_id = ${q.anuncioId}
       AND ultimo.capturado_em >= ${q.de}::date
       AND v.ocorrida_em < ultimo.capturado_em + make_interval(days => ${q.janelaDias})`
  return linha
}

export async function roiDaVeiculacao(sql: Sql, q: ConsultaRoi): Promise<RoiVeiculacao> {
  // A janela empurra o limite superior das vendas para além do fim do período:
  // um lead captado no último dia ainda pode comprar dentro da janela.
  const [limite] = await sql<{ ate: string }[]>`
    SELECT (${q.ate}::date + make_interval(days => ${q.janelaDias + 1}))::date::text AS ate`
  const ateMaisJanela = limite!.ate

  const [custo] = await sql<{ custo: string; impressoes: number; cliques: number }[]>`
    SELECT coalesce(sum(custo_centavos), 0)::text AS custo,
           coalesce(sum(impressoes), 0)::int      AS impressoes,
           coalesce(sum(cliques), 0)::int         AS cliques
      FROM midia_metrica_dia
     WHERE tenant_id = tenant_atual() AND anuncio_id = ${q.anuncioId}
       AND dia >= ${q.de}::date AND dia <= ${q.ate}::date`

  const [leads] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM midia_lead_origem
     WHERE tenant_id = tenant_atual() AND anuncio_id = ${q.anuncioId}
       AND capturado_em >= ${q.de}::date AND capturado_em < ${q.ate}::date + 1`

  const atrib = q.modelo === 'primeiro_toque'
    ? await atribuirPorPrimeiroToque(sql, q, ateMaisJanela)
    : await atribuirPorUltimoToque(sql, q, ateMaisJanela)

  // ⚠️ bigint volta como STRING do driver (INV-46). `Number()` explícito aqui,
  //    onde o tipo ainda é conhecido — nunca somando strings adiante.
  const custoCentavos = Number(custo?.custo ?? 0)
  const receitaCentavos = Number(atrib?.receita ?? 0)
  const receitaSemAmbiguidade = Number(atrib?.receita_sem_ambiguidade ?? 0)
  const nLeads = leads?.n ?? 0

  return {
    periodo: { de: q.de, ate: q.ate },
    custoCentavos,
    impressoes: custo?.impressoes ?? 0,
    cliques: custo?.cliques ?? 0,
    leads: nLeads,
    custoPorLeadCentavos: nLeads > 0 ? Math.round(custoCentavos / nLeads) : null,
    atribuicao: {
      modelo: q.modelo,
      janelaDias: q.janelaDias,
      vendas: atrib?.vendas ?? 0,
      receitaCentavos,
      roas: calcularRoas(receitaCentavos, custoCentavos),
    },
    semAmbiguidade: {
      vendas: atrib?.vendas_sem_ambiguidade ?? 0,
      receitaCentavos: receitaSemAmbiguidade,
      roas: calcularRoas(receitaSemAmbiguidade, custoCentavos),
    },
  }
}
