import { randomUUID } from 'node:crypto'
import type { Sql } from '../../db/index.js'

/**
 * Série temporal técnica (I-11) + regra de alerta (I-10). Postgres, agregado por
 * hora. A REGRA de entrega é pura (testável sem banco); o resto é upsert/leitura.
 */

/** Incrementa o balde da hora para uma métrica. Idempotente por (métrica, hora). */
export async function registrarMetrica(
  sql: Sql, metrica: string, incremento: number, agora: Date,
): Promise<void> {
  await sql`
    INSERT INTO metrica_janela (tenant_id, metrica, bucket, valor)
    VALUES (tenant_atual(), ${metrica}, date_trunc('hour', ${agora}::timestamptz), ${incremento})
    ON CONFLICT (tenant_id, metrica, bucket)
    DO UPDATE SET valor = metrica_janela.valor + ${incremento}`
}

/** Limiar da regra de entrega. Fora daqui não existe número mágico solto. */
export const REGRA_ENTREGA = {
  /** Abaixo de tantas amostras a taxa é ruído — não alerta. */
  minAmostras: 20,
  /** Taxa de sucesso abaixo disto = queda de entrega. */
  limiteTaxa: 0.7,
} as const

export interface Contagem { ok: number; falha: number }

/**
 * Regra PURA: a entrega caiu? ⚠️ Exige massa mínima (`minAmostras`) — 1 falha em
 * 2 envios não é incidente, é acaso. Só vira alerta com volume que sustente a taxa.
 */
export function avaliarEntrega(
  c: Contagem, regra: { minAmostras: number; limiteTaxa: number } = REGRA_ENTREGA,
): { alerta: boolean; taxa: number; amostras: number } {
  const amostras = c.ok + c.falha
  const taxa = amostras === 0 ? 1 : c.ok / amostras
  const alerta = amostras >= regra.minAmostras && taxa < regra.limiteTaxa
  return { alerta, taxa, amostras }
}

/**
 * Lê os últimos `horas` baldes de envio, aplica a regra e sobe/resolve o alerta.
 *
 * ⚠️ Dedup pelo índice parcial `alerta_aberto_unico`: se já há um aberto do tipo,
 * o INSERT não duplica. E quando a entrega VOLTA, resolve o aberto — senão o
 * alerta fica pendurado eternamente e o operador aprende a ignorá-lo.
 */
export async function avaliarEAlertarEntrega(sql: Sql, agora: Date, horas = 3): Promise<void> {
  const [linha] = await sql<{ ok: string; falha: string }[]>`
    SELECT
      coalesce(sum(valor) FILTER (WHERE metrica = 'envio_ok'), 0)::text    AS ok,
      coalesce(sum(valor) FILTER (WHERE metrica = 'envio_falha'), 0)::text AS falha
    FROM metrica_janela
    WHERE tenant_id = tenant_atual()
      AND metrica IN ('envio_ok', 'envio_falha')
      AND bucket >= date_trunc('hour', ${agora}::timestamptz) - make_interval(hours => ${horas})`

  const c: Contagem = { ok: Number(linha?.ok ?? 0), falha: Number(linha?.falha ?? 0) }
  const r = avaliarEntrega(c)

  if (r.alerta) {
    const pct = Math.round(r.taxa * 100)
    const nova = await sql<{ id: string }[]>`
      INSERT INTO alerta (tenant_id, id, tipo, severidade, mensagem)
      VALUES (tenant_atual(), ${randomUUID()}, 'entrega_baixa', 'critico',
              ${`Entrega em ${pct}% nas últimas ${horas}h (${c.falha} falhas em ${r.amostras} envios).`})
      ON CONFLICT (tenant_id, tipo) WHERE resolvido_em IS NULL DO NOTHING
      RETURNING id`
    // ⚠️ Evento SÓ quando um alerta NOVO nasce (o ON CONFLICT não retorna nada
    //    se já havia um aberto) — senão a tela piscaria a cada avaliação.
    if (nova.length) {
      await sql`
        INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id, payload)
        VALUES (tenant_atual(), 'alerta.novo', 'tenant', tenant_atual(), '{}'::jsonb)`
    }
  } else {
    // Entrega saudável de novo: resolve o alerta aberto, se houver.
    await sql`
      UPDATE alerta SET resolvido_em = now()
       WHERE tenant_id = tenant_atual() AND tipo = 'entrega_baixa' AND resolvido_em IS NULL`
  }
}
