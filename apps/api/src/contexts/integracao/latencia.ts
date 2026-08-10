import type { Sql } from '../../db/index.js'
import { registrarMetrica } from '../plataforma/metricas.js'

/**
 * Medição de latência do conector (Onda 2 — "última chance de medir antes de
 * cobrar receita na Onda 3"). ⚠️ Reusa a série temporal (I-11): grava SOMA e
 * CONTAGEM por balde de hora; a média = soma/n. Guardar só a média perderia a
 * agregação entre janelas — soma+contagem compõem sem mentir.
 *
 * A latência do ERP síncrono (saldo, preço, efetivar) é o que decide se o pedido
 * assistido é usável: acima de ~2s a vendedora monta às cegas (INV).
 */
export async function medirLatencia<T>(
  sql: Sql, conectorCodigo: string, chamada: string, agora: Date, fn: () => Promise<T>,
): Promise<T> {
  const inicio = Date.now()
  try {
    return await fn()
  } finally {
    const ms = Date.now() - inicio
    await registrarMetrica(sql, `lat_soma:${conectorCodigo}:${chamada}`, ms, agora)
    await registrarMetrica(sql, `lat_n:${conectorCodigo}:${chamada}`, 1, agora)
  }
}

/** Latência MÉDIA (ms) por (conector, chamada) nas últimas `horas`. */
export async function latenciaMedia(sql: Sql, horas = 24): Promise<
  { conector: string; chamada: string; mediaMs: number; amostras: number }[]
> {
  const linhas = await sql<{ metrica: string; total: string }[]>`
    SELECT metrica, sum(valor)::text AS total
      FROM metrica_janela
     WHERE tenant_id = tenant_atual()
       AND (metrica LIKE 'lat_soma:%' OR metrica LIKE 'lat_n:%')
       AND bucket >= date_trunc('hour', now()) - make_interval(hours => ${horas})
     GROUP BY metrica`

  // Junta soma e n por (conector, chamada).
  const somas = new Map<string, number>()
  const enes = new Map<string, number>()
  for (const l of linhas) {
    const [prefixo, ...resto] = l.metrica.split(':')
    const chave = resto.join(':')
    if (prefixo === 'lat_soma') somas.set(chave, Number(l.total))
    else if (prefixo === 'lat_n') enes.set(chave, Number(l.total))
  }
  return [...enes.entries()].map(([chave, n]) => {
    const [conector, chamada] = chave.split(':')
    return { conector: conector ?? '', chamada: chamada ?? '', mediaMs: n ? Math.round((somas.get(chave) ?? 0) / n) : 0, amostras: n }
  })
}
