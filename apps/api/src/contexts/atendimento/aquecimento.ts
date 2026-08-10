import type { Sql } from '../../db/index.js'

/**
 * Aquecimento de frota (Onda 3). ⚠️ O teto diário de disparo PROATIVO de um
 * número não-oficial cresce aos poucos — subir de 0 a 1000 no dia 1 queima o
 * número (ADR-021). A rampa é pura e explicável.
 */

/** Teto diário de disparo por dia de aquecimento (0-based). Ramp ~1.6×/dia, teto 1000. */
export function limiteDiario(dia: number): number {
  const base = 20
  const teto = 1000
  return Math.min(teto, Math.round(base * Math.pow(1.6, Math.max(0, dia))))
}

export interface StatusAquecimento {
  readonly emAquecimento: boolean
  readonly dia: number
  readonly limiteHoje: number
  readonly usadoHoje: number
  readonly restante: number
}

/**
 * Status de aquecimento de um número: dia, teto de hoje, quanto já disparou hoje
 * (envios de campanha por este canal) e quanto resta. Sem registro de
 * aquecimento → sem teto (número já quente / oficial).
 */
export async function statusAquecimento(sql: Sql, canalId: string, agora: Date): Promise<StatusAquecimento> {
  const [aq] = await sql<{ iniciado_em: Date }[]>`
    SELECT iniciado_em FROM canal_aquecimento
     WHERE tenant_id = tenant_atual() AND canal_id = ${canalId} AND ativo`
  if (!aq) return { emAquecimento: false, dia: 0, limiteHoje: Infinity, usadoHoje: 0, restante: Infinity }

  const dia = Math.floor((agora.getTime() - aq.iniciado_em.getTime()) / 86_400_000)
  const limiteHoje = limiteDiario(dia)

  // Disparos de campanha por ESTE número, hoje.
  const [uso] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n
      FROM campanha_envio ce
      JOIN campanha c ON c.tenant_id = ce.tenant_id AND c.id = ce.campanha_id
     WHERE ce.tenant_id = tenant_atual() AND c.canal_id = ${canalId}
       AND ce.estado = 'enviado' AND ce.enviado_em >= date_trunc('day', ${agora}::timestamptz)`
  const usadoHoje = uso?.n ?? 0
  return { emAquecimento: true, dia, limiteHoje, usadoHoje, restante: Math.max(0, limiteHoje - usadoHoje) }
}
