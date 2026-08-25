import type { Sql } from '../../db/index.js'

/**
 * FUNIL POR ORIGEM (AQ-39) — o instrumento de diagnóstico da operação de mídia.
 *
 * O painel de anúncios diz quanto cada peça custou; o ROI diz quanto uma peça
 * faturou. Nenhum dos dois responde a pergunta que decide o que fazer amanhã:
 * **em qual etapa o dinheiro está parando?**
 *
 * impressão → clique → lead → qualificado → pedido → venda
 *
 * ⚠️ Cada degrau tem um dono e uma ação diferente, e é isso que faz o funil
 * valer mais que a soma das partes:
 *
 * | Onde afunila | O que provavelmente é | Quem resolve |
 * |---|---|---|
 * | impressão → clique | criativo/segmentação | mídia |
 * | clique → lead | a landing page, ou o código se perdendo | produto |
 * | lead → qualificado | público errado, ou lead sem intenção | mídia + vendas |
 * | qualificado → pedido | atendimento, preço, estoque | vendas |
 * | pedido → venda | efetivação no ERP, crédito, logística | operação |
 *
 * ⚠️ **As três primeiras etapas são FATO; as três últimas dependem do MODELO de
 * atribuição.** Um funil que mistura os dois sem dizer qual é qual empresta ao
 * segundo a credibilidade do primeiro — é a mesma disciplina do ROI (AMK-009), e
 * por isso o modelo e a janela viajam no resultado.
 */

export type ModeloAtribuicao = 'primeiro_toque' | 'ultimo_toque'

export interface EtapaFunil {
  readonly etapa: 'impressao' | 'clique' | 'lead' | 'qualificado' | 'pedido' | 'venda'
  readonly rotulo: string
  readonly quantidade: number
  /**
   * ⚠️ Custo total do período ÷ quantidade desta etapa. `null` quando a etapa
   * está zerada — dividir por zero viraria Infinity, e exibir R$ 0,00 faria a
   * etapa que não converteu ninguém parecer a mais barata de todas.
   */
  readonly custoUnitarioCentavos: number | null
  /** Conversão desta etapa vinda da anterior. `null` na primeira. */
  readonly taxaDaAnterior: number | null
  /** `true` = medido. `false` = depende do modelo declarado. */
  readonly fato: boolean
}

export interface Funil {
  readonly periodo: { readonly de: string; readonly ate: string }
  readonly custoCentavos: number
  readonly modelo: ModeloAtribuicao
  readonly janelaDias: number
  readonly etapas: readonly EtapaFunil[]
  /**
   * ⚠️ O degrau com a MAIOR perda relativa. É a resposta operacional do relatório
   * — e ela é calculada, não deixada para o olho de quem lê a tabela.
   */
  readonly maiorPerda: { readonly de: string; readonly para: string; readonly taxa: number } | null
}

export interface ConsultaFunil {
  readonly de: string
  readonly ate: string
  readonly janelaDias: number
  readonly modelo: ModeloAtribuicao
}

const ROTULOS: Record<EtapaFunil['etapa'], string> = {
  impressao: 'Impressões',
  clique: 'Cliques',
  lead: 'Leads no CRM',
  qualificado: 'Qualificados',
  pedido: 'Pedidos',
  venda: 'Vendas',
}

/** Taxa de conversão entre dois degraus. `null` quando o de cima é zero. */
export function taxa(deQuantidade: number, paraQuantidade: number): number | null {
  return deQuantidade > 0 ? paraQuantidade / deQuantidade : null
}

/**
 * O degrau que mais perde, em termos RELATIVOS.
 *
 * ⚠️ Relativo, não absoluto: de 10.000 impressões para 200 cliques perdem-se
 * 9.800 pessoas, e isso é um funil NORMAL. De 20 qualificados para 1 pedido
 * perdem-se 19 — e é aí que está o problema. Ordenar por perda absoluta apontaria
 * sempre para o topo do funil e nunca diria nada.
 */
export function maiorPerdaRelativa(etapas: readonly EtapaFunil[]): Funil['maiorPerda'] {
  let pior: Funil['maiorPerda'] = null
  for (let i = 1; i < etapas.length; i++) {
    const t = etapas[i]!.taxaDaAnterior
    if (t === null) continue
    if (!pior || t < pior.taxa) {
      pior = { de: etapas[i - 1]!.rotulo, para: etapas[i]!.rotulo, taxa: t }
    }
  }
  return pior
}

/** Monta as etapas a partir dos números crus. Puro — testável sem banco. */
export function montarEtapas(
  n: { impressoes: number; cliques: number; leads: number; qualificados: number; pedidos: number; vendas: number },
  custoCentavos: number,
): EtapaFunil[] {
  const ordem: [EtapaFunil['etapa'], number, boolean][] = [
    ['impressao', n.impressoes, true],
    ['clique', n.cliques, true],
    ['lead', n.leads, true],
    // ⚠️ Daqui para baixo, o vínculo com a mídia é MODELO, não fato registrado.
    ['qualificado', n.qualificados, false],
    ['pedido', n.pedidos, false],
    ['venda', n.vendas, false],
  ]

  return ordem.map(([etapa, quantidade, fato], i) => ({
    etapa,
    rotulo: ROTULOS[etapa],
    quantidade,
    custoUnitarioCentavos: quantidade > 0 ? Math.round(custoCentavos / quantidade) : null,
    taxaDaAnterior: i === 0 ? null : taxa(ordem[i - 1]![1], quantidade),
    fato,
  }))
}

/**
 * O funil do tenant no período.
 *
 * ⚠️ `venda` é particionada por `ocorrida_em`: os limites ABSOLUTOS de data estão
 * na consulta para o planejador podar partição — sem eles, a varredura é da
 * tabela inteira (mesma armadilha documentada no `roi.ts`).
 */
export async function funilPorOrigem(sql: Sql, q: ConsultaFunil): Promise<Funil> {
  const [limite] = await sql<{ ate: string }[]>`
    SELECT (${q.ate}::date + make_interval(days => ${q.janelaDias + 1}))::date::text AS ate`
  const ateMaisJanela = limite!.ate

  const [midia] = await sql<{ impressoes: number; cliques: number; custo: string }[]>`
    SELECT coalesce(sum(impressoes), 0)::int      AS impressoes,
           coalesce(sum(cliques), 0)::int         AS cliques,
           coalesce(sum(custo_centavos), 0)::text AS custo
      FROM midia_metrica_dia
     WHERE tenant_id = tenant_atual()
       AND dia >= ${q.de}::date AND dia <= ${q.ate}::date`

  const [origens] = await sql<{ leads: number; qualificados: number }[]>`
    SELECT count(*)::int                                       AS leads,
           count(*) FILTER (WHERE c.qualificado IS TRUE)::int  AS qualificados
      FROM midia_lead_origem o
      JOIN contato c ON c.tenant_id = o.tenant_id AND c.id = o.contato_id
     WHERE o.tenant_id = tenant_atual()
       AND o.capturado_em >= ${q.de}::date
       AND o.capturado_em <  ${q.ate}::date + 1`

  // ⚠️ Pedido conta pela EXISTÊNCIA de um pedido do contato que veio de mídia na
  //    janela — não pelo estado dele. Filtrar por "efetivado" aqui misturaria o
  //    degrau "virou pedido" com o degrau "o ERP aceitou", que são problemas de
  //    donos diferentes.
  const [pedidos] = await sql<{ n: number }[]>`
    SELECT count(DISTINCT p.id)::int AS n
      FROM pedido p
      JOIN midia_lead_origem o
        ON o.tenant_id = p.tenant_id AND o.contato_id = p.contato_id
     WHERE p.tenant_id = tenant_atual()
       AND o.capturado_em >= ${q.de}::date
       AND o.capturado_em <  ${q.ate}::date + 1
       AND p.criado_em >= o.capturado_em
       AND p.criado_em <  o.capturado_em + make_interval(days => ${q.janelaDias})`

  const vendas = q.modelo === 'primeiro_toque'
    ? await vendasPorPrimeiroToque(sql, q, ateMaisJanela)
    : await vendasPorUltimoToque(sql, q, ateMaisJanela)

  const custoCentavos = Number(midia?.custo ?? 0)
  const etapas = montarEtapas({
    impressoes: midia?.impressoes ?? 0,
    cliques: midia?.cliques ?? 0,
    leads: origens?.leads ?? 0,
    qualificados: origens?.qualificados ?? 0,
    pedidos: pedidos?.n ?? 0,
    vendas,
  }, custoCentavos)

  return {
    periodo: { de: q.de, ate: q.ate },
    custoCentavos,
    modelo: q.modelo,
    janelaDias: q.janelaDias,
    etapas,
    maiorPerda: maiorPerdaRelativa(etapas),
  }
}

async function vendasPorPrimeiroToque(sql: Sql, q: ConsultaFunil, ateMaisJanela: string): Promise<number> {
  const [r] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n
      FROM midia_lead_origem o
      JOIN venda v ON v.tenant_id = o.tenant_id AND v.contato_id = o.contato_id
     WHERE o.tenant_id = tenant_atual()
       AND o.primeira
       AND o.capturado_em >= ${q.de}::date
       AND o.capturado_em <  ${q.ate}::date + 1
       AND v.cancelada_em IS NULL
       AND v.ocorrida_em >= ${q.de}::date
       AND v.ocorrida_em <  ${ateMaisJanela}::date
       AND v.ocorrida_em >= o.capturado_em
       AND v.ocorrida_em <  o.capturado_em + make_interval(days => ${q.janelaDias})`
  return r?.n ?? 0
}

async function vendasPorUltimoToque(sql: Sql, q: ConsultaFunil, ateMaisJanela: string): Promise<number> {
  const [r] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n
      FROM venda v
      JOIN LATERAL (
        SELECT o.capturado_em
          FROM midia_lead_origem o
         WHERE o.tenant_id = v.tenant_id AND o.contato_id = v.contato_id
           AND o.capturado_em <= v.ocorrida_em
         ORDER BY o.capturado_em DESC, o.id DESC
         LIMIT 1
      ) ultimo ON true
     WHERE v.tenant_id = tenant_atual()
       AND v.cancelada_em IS NULL
       AND v.ocorrida_em >= ${q.de}::date
       AND v.ocorrida_em <  ${ateMaisJanela}::date
       AND ultimo.capturado_em >= ${q.de}::date
       AND v.ocorrida_em < ultimo.capturado_em + make_interval(days => ${q.janelaDias})`
  return r?.n ?? 0
}
