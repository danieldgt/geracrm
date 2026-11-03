import type { Sql } from '../../db/index.js'
import { fusoSeguro } from './fuso.js'

/**
 * PERÍODO DE RELATÓRIO — datas locais do tenant (`yyyy-mm-dd`, inclusivas), no fuso do tenant.
 *
 * Padrão (sem `inicio` e `fim`): do dia 1 do mês atual até hoje, calculados com o `now()` do BANCO
 * no fuso do tenant — a fronteira de mês não depende do relógio nem do fuso do servidor.
 * Janela real: `[desde, ate)` em `timestamptz` (`ate` = 00:00 local do dia seguinte ao `fim`).
 */
export const PERIODO_MAX_DIAS = 366

export type ErroPeriodo = 'periodo.incompleto' | 'periodo.invalido' | 'periodo.invertido' | 'periodo.longo_demais'

const DIA = /^\d{4}-\d{2}-\d{2}$/
const MS_DIA = 86_400_000

/** `yyyy-mm-dd` que existe de verdade no calendário (2026-02-30 não). Devolve o instante UTC ou null. */
function diaUtc(texto: string): number | null {
  if (!DIA.test(texto)) return null
  const ms = Date.parse(`${texto}T00:00:00Z`)
  return Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== texto ? null : ms
}

/** Valida só a ENTRADA (função pura): ou os dois, ou nenhum; datas reais; início <= fim; máx. 366 dias. */
export function validarEntradaPeriodo(inicio: string | undefined, fim: string | undefined): ErroPeriodo | null {
  if (inicio === undefined && fim === undefined) return null
  if (inicio === undefined || fim === undefined) return 'periodo.incompleto'
  const a = diaUtc(inicio)
  const b = diaUtc(fim)
  if (a === null || b === null) return 'periodo.invalido'
  if (b < a) return 'periodo.invertido'
  if ((b - a) / MS_DIA + 1 > PERIODO_MAX_DIAS) return 'periodo.longo_demais'
  return null
}

export interface PeriodoResolvido {
  readonly inicio: string
  readonly fim: string
  readonly desde: Date
  readonly ate: Date
  readonly fuso: string
}

/** Resolve o período no fuso do tenant (e aplica o padrão do mês atual). Chame depois de `validarEntradaPeriodo`. */
export async function resolverPeriodo(tx: Sql, inicio?: string, fim?: string): Promise<PeriodoResolvido> {
  const [t] = await tx<{ fuso: string | null }[]>`SELECT fuso FROM tenant WHERE id = tenant_atual()`
  const fuso = fusoSeguro(t?.fuso)
  const [p] = await tx<{ inicio: string; fim: string; desde: Date; ate: Date }[]>`
    SELECT to_char(x.i, 'YYYY-MM-DD') AS inicio, to_char(x.f, 'YYYY-MM-DD') AS fim,
           x.i::timestamp AT TIME ZONE ${fuso}::text AS desde,
           (x.f + 1)::timestamp AT TIME ZONE ${fuso}::text AS ate
      FROM (SELECT coalesce(${inicio ?? null}::date, date_trunc('month', now() AT TIME ZONE ${fuso}::text)::date) AS i,
                   coalesce(${fim ?? null}::date, (now() AT TIME ZONE ${fuso}::text)::date) AS f) x`
  return { inicio: p!.inicio, fim: p!.fim, desde: p!.desde, ate: p!.ate, fuso }
}
