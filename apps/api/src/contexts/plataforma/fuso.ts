/**
 * FUSO DO TENANT — validado e convertido em TS, nunca no `AT TIME ZONE` do SQL.
 *
 * ⚠️ `tenant.fuso` é texto livre (a tela de empresa gravava o que viesse). Um
 *    fuso inválido no `AT TIME ZONE` derruba a CONSULTA inteira — e com ela o
 *    turno do agente e a tela de configuração (500). Aqui o fuso inválido cai no
 *    padrão e a hora local sai em TS com `Intl`, que não lança depois da checagem.
 */

export const FUSO_PADRAO = 'America/Sao_Paulo'

/** É um fuso IANA que o runtime conhece? ("America/Sao_Paulo" sim; "Brasil/Ceara" não.) */
export function fusoValido(fuso: string | null | undefined): fuso is string {
  if (!fuso || typeof fuso !== 'string') return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: fuso })
    return true
  } catch {
    return false
  }
}

/** O fuso, ou o padrão quando ausente/inválido. */
export function fusoSeguro(fuso: string | null | undefined): string {
  return fusoValido(fuso) ? fuso : FUSO_PADRAO
}

const DIA_ISO: Readonly<Record<string, number>> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }

/** Data ("YYYY-MM-DD"), dia ISO (1 = segunda … 7 = domingo) e "HH:MM" locais no fuso — fuso inválido usa o padrão. */
export function momentoNoFuso(agora: Date, fuso: string | null | undefined): { diaIso: number; hora: string; data: string } {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: fusoSeguro(fuso), weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(agora)
  const p = (t: string) => partes.find((x) => x.type === t)?.value ?? ''
  return {
    diaIso: DIA_ISO[p('weekday')] ?? 1,
    hora: `${p('hour').padStart(2, '0')}:${p('minute').padStart(2, '0')}`,
    data: `${p('year')}-${p('month')}-${p('day')}`,
  }
}
