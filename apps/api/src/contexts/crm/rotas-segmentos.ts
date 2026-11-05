import {
  classificarRfv, CODIGOS_SEGMENTO_RFV, faixasDoSegmento, type CodigoSegmentoRfv, type FaixaRfv, type MetricasRfv,
} from '@geracrm/shared'
import type { FastifyInstance } from 'fastify'
import { exigirTenant } from '../../plugins/tenant.js'
import type { Sql } from '../../db/index.js'
import { condicaoSegmentoDaFaixa } from './contatos-filtros.js'

/**
 * Segmentos RFV (Onda 2/3) — a distribuição da base por segmento, com contagem
 * e valor. ⚠️ A regra é a MESMA `classificarRfv` do resto (shared): a tela não
 * reinventa fronteira de segmento. Leitura pura sobre `metricas_contato`.
 */
export interface SegmentoResumo {
  codigo: CodigoSegmentoRfv | 'sem_metrica'
  rotulo: string
  acao: string
  urgencia: number
  contatos: number
  receitaCentavos: number
}

/**
 * Uma faixa de `faixasDoSegmento` com métricas REPRESENTATIVAS (dentro da faixa),
 * para obter rótulo/ação/urgência da MESMA `classificarRfv` — a régua continua
 * num lugar só (shared).
 */
function metricasDaFaixa(f: FaixaRfv): MetricasRfv {
  if (f.tipo === 'sem_ritmo_recente') return { qtdVendas: 1, diasSemComprar: 0, atrasoRelativo: null }
  if (f.tipo === 'sem_ritmo_parado') return { qtdVendas: 1, diasSemComprar: null, atrasoRelativo: null }
  return { qtdVendas: 2, diasSemComprar: 0, atrasoRelativo: f.ate ?? (f.apos ?? 0) + 1 }
}

/**
 * ⚠️ A agregação é no SQL: um `GROUP BY` da faixa de segmento (as fronteiras
 * saem de `faixasDoSegmento`, as mesmas do filtro de contatos). A leitura devolve
 * no máximo uma linha por faixa — não cresce com a base. Contato sem linha em
 * `metricas_contato` (nunca comprou) fica fora, como antes.
 */
export async function distribuicaoRfv(sql: Sql): Promise<SegmentoResumo[]> {
  const faixas = CODIGOS_SEGMENTO_RFV.flatMap((codigo) => faixasDoSegmento(codigo).map((faixa) => ({ codigo, faixa })))
  const casos = faixas.map(({ faixa }, i) =>
    sql`WHEN ${condicaoSegmentoDaFaixa(sql, faixa)} THEN ${i}::int`)
  const linhas = await sql<{ k: number; contatos: string; total: string }[]>`
    SELECT CASE ${casos.reduce((acc, c, i) => (i === 0 ? c : sql`${acc} ${c}`), sql`WHEN false THEN -1`)} END AS k,
           count(*)::text AS contatos, coalesce(sum(m.total_centavos), 0)::text AS total
      FROM metricas_contato m
     WHERE m.tenant_id = tenant_atual()
     GROUP BY 1`

  const mapa = new Map<string, SegmentoResumo & { maior: number }>()
  for (const l of linhas) {
    const f = faixas[l.k]
    if (!f) continue
    const s = classificarRfv(metricasDaFaixa(f.faixa))
    const n = Number(l.contatos)
    const at = mapa.get(s.codigo) ?? { codigo: s.codigo, rotulo: s.rotulo, acao: s.acao, urgencia: s.urgencia, contatos: 0, receitaCentavos: 0, maior: 0 }
    // O rótulo do código vem da faixa com mais contatos (o mesmo código pode ter duas faixas).
    if (n > at.maior) { at.rotulo = s.rotulo; at.acao = s.acao; at.maior = n }
    at.contatos += n
    at.receitaCentavos += Number(l.total)
    mapa.set(s.codigo, at)
  }
  // Ordena por urgência (quem precisa de ação primeiro no topo).
  return [...mapa.values()]
    .map(({ maior: _m, ...r }) => r)
    .sort((a, b) => b.urgencia - a.urgencia)
}

/**
 * ⚠️ Sem cursor, de propósito: o conjunto é FIXO por construção — um item por
 * código de segmento RFV (`classificarRfv`, em shared: 6 códigos mais
 * `sem_metrica`), nunca por contato. A resposta agrega a base, não a lista.
 * `TETO_SEGMENTOS` é só a trava explícita contra regressão.
 */
const TETO_SEGMENTOS = 50

export async function rotasSegmentos(app: FastifyInstance): Promise<void> {
  app.get('/v1/segmentos', { preHandler: exigirTenant }, async (req, reply) => {
    const itens = (await req.comTenant((tx) => distribuicaoRfv(tx))).slice(0, TETO_SEGMENTOS)
    const totalContatos = itens.reduce((s, i) => s + i.contatos, 0)
    return reply.send({ itens, totalContatos })
  })
}
