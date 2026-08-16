import { randomUUID } from 'node:crypto'
import { classificarRfv } from '@geracrm/shared'
import type { Sql } from '../../db/index.js'

/**
 * Snapshot da TRAJETÓRIA de segmento RFV (skill funil-de-vendas). Roda no worker
 * (dono), na mesma passada agendada das automações. Lê a MV crua filtrada por
 * tenant, classifica com a MESMA régua (classificarRfv), e grava UMA linha por
 * contato SÓ QUANDO o segmento mudou desde a última captura — a série guarda
 * transições, não repetições.
 */
const LOTE = 500

/** Captura as mudanças de segmento de UM tenant. Devolve quantas transições gravou. */
export async function capturarSegmentosTenant(sql: Sql, tid: string): Promise<number> {
  const linhas = await sql<{
    contato_id: string; qtd_vendas: number; dias_sem_comprar: number | null
    atraso: string | null; ultimo: string | null
  }[]>`
    SELECT m.contato_id, m.qtd_vendas, m.dias_sem_comprar, m.atraso_relativo::text AS atraso,
           h.segmento AS ultimo
      FROM mv_metricas_contato m
      LEFT JOIN LATERAL (
        SELECT s.segmento FROM contato_segmento_historico s
         WHERE s.tenant_id = m.tenant_id AND s.contato_id = m.contato_id
         ORDER BY s.capturado_em DESC LIMIT 1
      ) h ON true
     WHERE m.tenant_id = ${tid}`

  const novos: { tenant_id: string; id: string; contato_id: string; segmento: string }[] = []
  for (const l of linhas) {
    const s = classificarRfv({
      qtdVendas: Number(l.qtd_vendas),
      diasSemComprar: l.dias_sem_comprar,
      atrasoRelativo: l.atraso === null ? null : Number(l.atraso),
    })
    // Só grava quando MUDOU (ou é a primeira foto do contato).
    if (s.codigo !== l.ultimo) novos.push({ tenant_id: tid, id: randomUUID(), contato_id: l.contato_id, segmento: s.codigo })
  }
  if (novos.length === 0) return 0
  // ⚠️ A primeira passada carimba a base inteira — insere em lotes.
  for (let i = 0; i < novos.length; i += LOTE) {
    const lote = novos.slice(i, i + LOTE)
    await sql`INSERT INTO contato_segmento_historico ${sql(lote, 'tenant_id', 'id', 'contato_id', 'segmento')}`
  }
  return novos.length
}

/**
 * Passada por TODOS os tenants. Guardada por advisory lock (várias instâncias não
 * capturam em dobro). Roda como DONO — isolamento pelo tenant explícito.
 */
export async function capturarSegmentos(sql: Sql): Promise<number> {
  const [trava] = await sql<{ ok: boolean }[]>`SELECT pg_try_advisory_lock(hashtext('segmento_snapshot')) AS ok`
  if (!trava?.ok) return 0
  let total = 0
  try {
    const tenants = await sql<{ tenant_id: string }[]>`SELECT DISTINCT tenant_id FROM mv_metricas_contato`
    for (const t of tenants) total += await capturarSegmentosTenant(sql, t.tenant_id)
  } finally {
    await sql`SELECT pg_advisory_unlock(hashtext('segmento_snapshot'))`
  }
  return total
}
