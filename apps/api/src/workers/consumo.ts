import type { Sql } from '../db/index.js'

/**
 * WORKER DO CONSUMO (F2, migration 0124) — atualiza a view materializada `mv_consumo_diario`
 * que alimenta a tela de Consumo. Agendado em `server.ts` (1ª passada logo após o boot, depois
 * a cada 15 min).
 *
 * ⚠️ `REFRESH … CONCURRENTLY` (índice único na MV): não bloqueia a leitura da tela. Trava
 *    advisory de sessão: com várias instâncias, só uma atualiza por vez; a outra pula.
 * ⚠️ Sem tenant: é manutenção de agregado, como dono. O dia de HOJE nunca depende dele — a API
 *    completa o dia corrente direto das tabelas (`consumo_base`).
 */
export const INTERVALO_CONSUMO_MS = 15 * 60_000
export const ATRASO_PRIMEIRA_PASSADA_CONSUMO_MS = 90_000

export interface RelatorioConsumo {
  /** 1 quando atualizou; 0 quando outra instância já estava atualizando. */
  processadas: number
}

export async function atualizarConsumoDiario(dono: Sql): Promise<RelatorioConsumo> {
  const [trava] = await dono<{ ok: boolean }[]>`SELECT pg_try_advisory_lock(hashtext('consumo_diario')) AS ok`
  if (!trava?.ok) return { processadas: 0 }
  try {
    await dono`SELECT atualizar_consumo_diario()`
    return { processadas: 1 }
  } finally {
    await dono`SELECT pg_advisory_unlock(hashtext('consumo_diario'))`
  }
}
