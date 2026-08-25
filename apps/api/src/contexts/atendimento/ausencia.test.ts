import { describe, it, expect } from 'vitest'
import { foraDoExpediente } from './ausencia.js'

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
