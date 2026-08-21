import { classificarRfv } from '@geracrm/shared'
import type { Sql } from '../../db/index.js'

/**
 * Audiência (por segmento RFV) e ROI de campanha (Onda 3).
 *
 * ⚠️ ROI: a atribuição EXATA (pedido nascido da campanha) e a ESTIMADA (comprou
 * na janela) vêm SEPARADAS e rotuladas — somar as duas infla o número e vira
 * promessa que o produto não sustenta (skill funil-de-vendas).
 */

/** Contatos que caem no segmento RFV alvo ('todos' = todos com métrica). */
export async function audienciaDoSegmento(sql: Sql, segmento: string): Promise<string[]> {
  const linhas = await sql<{
    contato_id: string; qtd_vendas: number; dias_sem_comprar: number | null; atraso_relativo: string | null
  }[]>`
    SELECT contato_id, qtd_vendas, dias_sem_comprar, atraso_relativo::text
      FROM metricas_contato WHERE tenant_id = tenant_atual()`
  return linhas
    .filter((l) => {
      if (segmento === 'todos') return true
      const s = classificarRfv({
        qtdVendas: Number(l.qtd_vendas),
        diasSemComprar: l.dias_sem_comprar,
        atrasoRelativo: l.atraso_relativo === null ? null : Number(l.atraso_relativo),
      })
      return s.codigo === segmento
    })
    .map((l) => l.contato_id)
}

export interface Roi {
  readonly disparadaEm: Date | null
  readonly janelaDias: number
  /** Fato: pedido nasceu vinculado à campanha. */
  readonly exata: { pedidos: number; receitaCentavos: number }
  /** Correlação: destinatário comprou (no ERP) dentro da janela. */
  readonly estimada: { vendas: number; receitaCentavos: number }
  readonly enviados: number
}

export async function roiCampanha(sql: Sql, campanhaId: string): Promise<Roi | null> {
  const [c] = await sql<{ disparada_em: Date | null; janela: number }[]>`
    SELECT disparada_em, janela_atribuicao_dias AS janela
      FROM campanha WHERE tenant_id = tenant_atual() AND id = ${campanhaId}`
  if (!c) return null

  const [exata] = await sql<{ pedidos: number; receita: string }[]>`
    SELECT count(*)::int AS pedidos, coalesce(sum(total_centavos), 0)::text AS receita
      FROM pedido WHERE tenant_id = tenant_atual() AND campanha_id = ${campanhaId} AND estado = 'efetivado'`

  const [enviados] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM campanha_envio
     WHERE tenant_id = tenant_atual() AND campanha_id = ${campanhaId} AND estado = 'enviado'`

  // Estimada: venda no ERP por destinatário DENTRO da janela após o disparo.
  // Só faz sentido depois de disparada.
  // ⚠️ `cancelada_em IS NULL`: venda cancelada não é receita. Sem este filtro o
  //    número inflava na direção que AGRADA — o tipo de erro que ninguém reporta
  //    porque melhora o relatório. É a convenção do resto do repositório (BI,
  //    painel, funil, ficha do contato).
  // ⚠️ A EXATA não precisa do filtro: 'cancelado' é ESTADO do pedido (0038),
  //    mutuamente exclusivo com 'efetivado' — o `estado = 'efetivado'` já basta.
  let estimada = { vendas: 0, receitaCentavos: 0 }
  if (c.disparada_em) {
    const [e] = await sql<{ vendas: number; receita: string }[]>`
      SELECT count(*)::int AS vendas, coalesce(sum(v.valor_centavos), 0)::text AS receita
        FROM campanha_envio ce
        JOIN venda v ON v.tenant_id = ce.tenant_id AND v.contato_id = ce.contato_id
       WHERE ce.tenant_id = tenant_atual() AND ce.campanha_id = ${campanhaId} AND ce.estado = 'enviado'
         AND v.cancelada_em IS NULL
         AND v.ocorrida_em >= ${c.disparada_em}
         AND v.ocorrida_em < ${c.disparada_em} + make_interval(days => ${c.janela})`
    estimada = { vendas: e?.vendas ?? 0, receitaCentavos: Number(e?.receita ?? 0) }
  }

  return {
    disparadaEm: c.disparada_em,
    janelaDias: c.janela,
    exata: { pedidos: exata?.pedidos ?? 0, receitaCentavos: Number(exata?.receita ?? 0) },
    estimada,
    enviados: enviados?.n ?? 0,
  }
}
