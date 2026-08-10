import { classificarRfv, type CodigoSegmentoRfv } from '@geracrm/shared'
import type { FastifyInstance } from 'fastify'
import { exigirTenant } from '../../plugins/tenant.js'
import type { Sql } from '../../db/index.js'

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

export async function distribuicaoRfv(sql: Sql): Promise<SegmentoResumo[]> {
  const linhas = await sql<{
    qtd_vendas: number; dias_sem_comprar: number | null; atraso_relativo: string | null; total_centavos: string
  }[]>`
    SELECT qtd_vendas, dias_sem_comprar, atraso_relativo::text, total_centavos::text
      FROM metricas_contato WHERE tenant_id = tenant_atual()`

  const mapa = new Map<string, SegmentoResumo>()
  for (const l of linhas) {
    const s = classificarRfv({
      qtdVendas: Number(l.qtd_vendas),
      diasSemComprar: l.dias_sem_comprar,
      atrasoRelativo: l.atraso_relativo === null ? null : Number(l.atraso_relativo),
    })
    const at = mapa.get(s.codigo) ?? { codigo: s.codigo, rotulo: s.rotulo, acao: s.acao, urgencia: s.urgencia, contatos: 0, receitaCentavos: 0 }
    at.contatos += 1
    at.receitaCentavos += Number(l.total_centavos)
    mapa.set(s.codigo, at)
  }
  // Ordena por urgência (quem precisa de ação primeiro no topo).
  return [...mapa.values()].sort((a, b) => b.urgencia - a.urgencia)
}

export async function rotasSegmentos(app: FastifyInstance): Promise<void> {
  app.get('/v1/segmentos', { preHandler: exigirTenant }, async (req, reply) => {
    const itens = await req.comTenant((tx) => distribuicaoRfv(tx))
    const totalContatos = itens.reduce((s, i) => s + i.contatos, 0)
    return reply.send({ itens, totalContatos })
  })
}
