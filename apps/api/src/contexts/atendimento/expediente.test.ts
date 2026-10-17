import { describe, it, expect } from 'vitest'
import { foraDoExpediente, instanteLocal, partesLocais, proximaAbertura, situacaoDoExpediente } from './expediente.js'

/**
 * A régua do expediente.
 *
 * ⚠️ É aqui que mora o erro caro: uma decisão errada manda resposta automática
 * para o cliente DURANTE o atendimento, ou cala o produto a noite inteira. Por
 * isso a regra é pura e a hora entra pronta (calculada no fuso do tenant pelo
 * banco) — data e fuso em JavaScript são a receita conhecida de errar por uma
 * hora e só descobrir no horário de verão.
 */
const COMERCIAL = {
  seg: { de: '09:00', ate: '18:00' },
  ter: { de: '09:00', ate: '18:00' },
  qua: { de: '09:00', ate: '18:00' },
  qui: { de: '09:00', ate: '18:00' },
  sex: { de: '09:00', ate: '18:00' },
  sab: { de: '09:00', ate: '13:00' },
  dom: null,
}

describe('Dentro e fora do expediente', () => {
  it('meio da tarde de terça está DENTRO', () => {
    expect(foraDoExpediente(COMERCIAL, 2, '14:30')).toBe(false)
  })

  it('dez da noite de terça está FORA', () => {
    expect(foraDoExpediente(COMERCIAL, 2, '22:00')).toBe(true)
  })

  it('domingo (dia fechado) está fora o dia inteiro', () => {
    expect(foraDoExpediente(COMERCIAL, 7, '14:30')).toBe(true)
  })

  it('sábado fecha às 13h — 14h já é fora', () => {
    expect(foraDoExpediente(COMERCIAL, 6, '12:59')).toBe(false)
    expect(foraDoExpediente(COMERCIAL, 6, '14:00')).toBe(true)
  })

  /** ⚠️ A borda: abre às 09:00 significa que 09:00 JÁ é expediente. */
  it('o minuto da abertura já conta como aberto; o do fechamento, não', () => {
    expect(foraDoExpediente(COMERCIAL, 2, '09:00')).toBe(false)
    expect(foraDoExpediente(COMERCIAL, 2, '08:59')).toBe(true)
    expect(foraDoExpediente(COMERCIAL, 2, '18:00')).toBe(true)
  })
})

describe('⚠️ Horário não configurado NÃO é "fechado"', () => {
  /**
   * Assumir fechado mandaria resposta automática 24h por dia para todo tenant
   * que nunca abriu essa tela — e o primeiro a descobrir seria o cliente dele.
   * Quem não declarou expediente não declarou ausência.
   */
  it('sem horário, nunca responde', () => {
    expect(foraDoExpediente(null, 2, '03:00')).toBe(false)
    expect(foraDoExpediente(undefined, 2, '03:00')).toBe(false)
    expect(foraDoExpediente({}, 2, '03:00')).toBe(false)
  })
})

describe('⚠️ Faixa que cruza a meia-noite', () => {
  /**
   * Loja que atende das 22h às 2h existe (delivery, plantão). Sem este ramo, ela
   * seria considerada FECHADA durante o próprio expediente — e mandaria "estamos
   * fechados" para quem está sendo atendido naquele instante.
   */
  const NOTURNO = { seg: null, ter: { de: '22:00', ate: '02:00' }, qua: null, qui: null, sex: null, sab: null, dom: null }

  it('23h está dentro', () => {
    expect(foraDoExpediente(NOTURNO, 2, '23:00')).toBe(false)
  })

  it('01h está dentro', () => {
    expect(foraDoExpediente(NOTURNO, 2, '01:00')).toBe(false)
  })

  it('15h está fora', () => {
    expect(foraDoExpediente(NOTURNO, 2, '15:00')).toBe(true)
  })
})

describe('Feriados e próxima abertura (P11; contrato da P18)', () => {
  /** Fortaleza: UTC-3 o ano todo — "09:00 local" = 12:00Z. */
  const FZ = 'America/Fortaleza'
  const z = (iso: string) => new Date(iso)

  it('partes locais no fuso do tenant, nunca no do servidor', () => {
    // 02:30Z de sábado é 23:30 de sexta em Fortaleza.
    expect(partesLocais(z('2026-10-17T02:30:00Z'), FZ)).toEqual({ data: '2026-10-16', diaIso: 5, hora: '23:30' })
  })

  it('dentro do expediente, a próxima abertura é o próprio instante', () => {
    const agora = z('2026-10-20T17:30:00Z')   // terça 14:30
    expect(situacaoDoExpediente(COMERCIAL, [], agora, FZ)).toBe('aberto')
    expect(proximaAbertura(COMERCIAL, [], agora, FZ)).toEqual(agora)
  })

  it('⚠️ fronteira da abertura: 08:59 adia para 09:00 do MESMO dia; 09:00 já sai', () => {
    expect(proximaAbertura(COMERCIAL, [], z('2026-10-20T11:59:00Z'), FZ)).toEqual(z('2026-10-20T12:00:00Z'))
    expect(proximaAbertura(COMERCIAL, [], z('2026-10-20T12:00:00Z'), FZ)).toEqual(z('2026-10-20T12:00:00Z'))
  })

  it('⚠️ fronteira do fechamento: 18:00 já é fora e abre às 09:00 do dia seguinte', () => {
    expect(situacaoDoExpediente(COMERCIAL, [], z('2026-10-20T20:59:00Z'), FZ)).toBe('aberto')
    expect(situacaoDoExpediente(COMERCIAL, [], z('2026-10-20T21:00:00Z'), FZ)).toBe('fora_do_expediente')
    expect(proximaAbertura(COMERCIAL, [], z('2026-10-20T21:00:00Z'), FZ)).toEqual(z('2026-10-21T12:00:00Z'))
  })

  it('sábado 13h fecha e domingo é fechado: a próxima é segunda 09:00', () => {
    expect(proximaAbertura(COMERCIAL, [], z('2026-10-17T16:00:00Z'), FZ)).toEqual(z('2026-10-19T12:00:00Z'))
  })

  it('⚠️ feriado fecha o dia inteiro, por data exata ou recorrente (MM-DD)', () => {
    const sexta20 = z('2026-11-20T14:00:00Z')   // Consciência Negra, sexta 11:00
    expect(situacaoDoExpediente(COMERCIAL, ['2026-11-20'], sexta20, FZ)).toBe('feriado')
    expect(situacaoDoExpediente(COMERCIAL, ['11-20'], sexta20, FZ)).toBe('feriado')
    expect(situacaoDoExpediente(COMERCIAL, ['2025-11-20'], sexta20, FZ)).toBe('aberto')
    // Pula o feriado e cai no sábado 09:00.
    expect(proximaAbertura(COMERCIAL, ['11-20'], sexta20, FZ)).toEqual(z('2026-11-21T12:00:00Z'))
  })

  it('⚠️ fronteira do feriado: 23:59 da véspera é a véspera; 00:00 já é feriado', () => {
    expect(situacaoDoExpediente({}, ['12-25'], z('2026-12-25T02:59:00Z'), FZ)).toBe('aberto')
    expect(situacaoDoExpediente({}, ['12-25'], z('2026-12-25T03:00:00Z'), FZ)).toBe('feriado')
  })

  it('véspera às 20h + feriado no dia seguinte: pula direto para o próximo dia útil', () => {
    // Quinta 24/12 20:00 → 25/12 feriado (sexta) → sábado 26/12 09:00.
    expect(proximaAbertura(COMERCIAL, ['12-25'], z('2026-12-24T23:00:00Z'), FZ)).toEqual(z('2026-12-26T12:00:00Z'))
  })

  it('sem horário configurado só o feriado fecha — reabre à meia-noite seguinte', () => {
    expect(proximaAbertura({}, [], z('2026-10-20T06:00:00Z'), FZ)).toEqual(z('2026-10-20T06:00:00Z'))
    expect(proximaAbertura(null, ['10-20'], z('2026-10-20T15:00:00Z'), FZ)).toEqual(z('2026-10-21T03:00:00Z'))
  })

  it('tudo fechado no horizonte → null (quem chama decide)', () => {
    const fechado = { seg: null, ter: null, qua: null, qui: null, sex: null, sab: null, dom: null }
    expect(proximaAbertura(fechado, [], z('2026-10-20T15:00:00Z'), FZ)).toBeNull()
  })

  it('⚠️ horário de verão: 09:00 em Nova York é 13:00Z no verão e 14:00Z no inverno', () => {
    const NY = 'America/New_York'
    const SEG = { seg: { de: '09:00', ate: '18:00' } }
    // Sábado 07/03 → segunda 09/03 (horário de verão desde domingo 08/03).
    expect(proximaAbertura(SEG, [], z('2026-03-07T15:00:00Z'), NY)).toEqual(z('2026-03-09T13:00:00Z'))
    // Sábado 31/10 → segunda 02/11 (horário padrão desde domingo 01/11).
    expect(proximaAbertura(SEG, [], z('2026-10-31T15:00:00Z'), NY)).toEqual(z('2026-11-02T14:00:00Z'))
    // Hora que não existe (02:30 no pulo) cai depois, nunca antes.
    expect(instanteLocal('2026-03-08', '02:30', NY).getTime()).toBeGreaterThanOrEqual(z('2026-03-08T07:00:00Z').getTime())
  })
})
