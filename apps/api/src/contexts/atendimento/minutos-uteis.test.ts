import { describe, it, expect } from 'vitest'
import { somarMinutosUteis } from './minutos-uteis.js'
import type { HorarioAtendimento } from './expediente.js'

/**
 * somarMinutosUteis — o relógio do SLA do handoff (P18). Pura, sem banco.
 * Datas em America/Sao_Paulo (UTC−3, sem horário de verão desde 2019):
 * 2026-10-19 é segunda-feira.
 */
const SP = 'America/Sao_Paulo'
const COMERCIAL: HorarioAtendimento = {
  seg: { de: '08:00', ate: '18:00' }, ter: { de: '08:00', ate: '18:00' }, qua: { de: '08:00', ate: '18:00' },
  qui: { de: '08:00', ate: '18:00' }, sex: { de: '08:00', ate: '18:00' }, sab: null, dom: null,
}
const NOTURNO: HorarioAtendimento = {
  seg: { de: '22:00', ate: '02:00' }, ter: { de: '22:00', ate: '02:00' }, qua: { de: '22:00', ate: '02:00' },
  qui: { de: '22:00', ate: '02:00' }, sex: { de: '22:00', ate: '02:00' }, sab: { de: '22:00', ate: '02:00' }, dom: { de: '22:00', ate: '02:00' },
}
/** "2026-10-19 10:00" local de SP → Date. */
const sp = (s: string) => new Date(`${s.replace(' ', 'T')}:00-03:00`)

describe('somarMinutosUteis', () => {
  const casos: Array<[string, Date, number, HorarioAtendimento | null, string[], Date | null]> = [
    ['dentro do expediente: soma direto', sp('2026-10-19 10:00'), 30, COMERCIAL, [], sp('2026-10-19 10:30')],
    ['cruza o fechamento: resto na abertura seguinte', sp('2026-10-19 17:50'), 30, COMERCIAL, [], sp('2026-10-20 08:20')],
    ['termina exatamente no fechamento: vence no fechamento', sp('2026-10-19 17:30'), 30, COMERCIAL, [], sp('2026-10-19 18:00')],
    ['antes de abrir: conta da abertura', sp('2026-10-19 06:00'), 30, COMERCIAL, [], sp('2026-10-19 08:30')],
    ['depois de fechar: conta da próxima abertura', sp('2026-10-19 21:00'), 30, COMERCIAL, [], sp('2026-10-20 08:30')],
    ['sexta à tarde atravessa o fim de semana', sp('2026-10-23 17:45'), 30, COMERCIAL, [], sp('2026-10-26 08:15')],
    ['sábado: conta da segunda', sp('2026-10-24 11:00'), 60, COMERCIAL, [], sp('2026-10-26 09:00')],
    ['feriado (AAAA-MM-DD) pula o dia', sp('2026-10-19 17:50'), 30, COMERCIAL, ['2026-10-20'], sp('2026-10-21 08:20')],
    ['feriado anual (MM-DD) também', sp('2026-11-01 12:00'), 30, COMERCIAL, ['11-02'], sp('2026-11-03 08:30')],
    ['faixa que vira a meia-noite: cruza 00:00 contando', sp('2026-10-19 23:45'), 30, NOTURNO, [], sp('2026-10-20 00:15')],
    ['faixa noturna: fecha às 02:00 e volta às 22:00', sp('2026-10-20 01:50'), 30, NOTURNO, [], sp('2026-10-20 22:20')],
    ['sem horário configurado: relógio corrido', sp('2026-10-19 23:50'), 30, null, [], sp('2026-10-20 00:20')],
    ['sem horário, mas feriado fecha o dia', sp('2026-10-19 23:50'), 30, null, ['2026-10-20'], sp('2026-10-21 00:20')],
    ['zero minutos fora do expediente = próxima abertura', sp('2026-10-19 20:00'), 0, COMERCIAL, [], sp('2026-10-20 08:00')],
    ['tudo fechado: null (quem chama decide)', sp('2026-10-19 10:00'), 30,
      { seg: null, ter: null, qua: null, qui: null, sex: null, sab: null, dom: null }, [], null],
  ]
  it.each(casos)('%s', (_n, inicio, min, horario, feriados, esperado) => {
    expect(somarMinutosUteis(inicio, min, horario, feriados, SP)?.toISOString() ?? null).toBe(esperado?.toISOString() ?? null)
  })

  it('usa o fuso do tenant, não o do servidor (Nova York, virada do horário de verão)', () => {
    const ny: HorarioAtendimento = { sab: { de: '09:00', ate: '17:00' }, dom: { de: '09:00', ate: '17:00' }, seg: { de: '09:00', ate: '17:00' } }
    // 2026-11-01 (domingo) é a volta do horário de verão em NY: 16:50 EST = 21:50Z.
    const r = somarMinutosUteis(new Date('2026-11-01T21:50:00Z'), 30, ny, [], 'America/New_York')
    // 10 min no domingo + 20 min na segunda 09:00 EST (14:00Z) → 14:20Z.
    expect(r?.toISOString()).toBe('2026-11-02T14:20:00.000Z')
  })
})
