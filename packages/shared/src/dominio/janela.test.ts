import { describe, it, expect } from 'vitest'
import { calcularJanela, permiteTextoLivre } from './janela.js'

const base = new Date('2026-08-08T09:00:00.000Z')
const maisHoras = (d: Date, h: number) => new Date(d.getTime() + h * 3600_000)

describe('Janela de atendimento de 24h', () => {
  it('dado que o cliente nunca escreveu, então a janela está fechada', () => {
    const janela = calcularJanela(null, base)
    expect(janela.aberta).toBe(false)
    expect(janela.estado).toBe('fechada')
    expect(janela.expiraEm).toBeNull()
  })

  // ⚠️ As fronteiras: 23h e 24h. É nelas que quebra — não em 1h ou 100h.
  it('dado que a última entrante foi há 23h, então a janela está aberta', () => {
    const janela = calcularJanela(base, maisHoras(base, 23))
    expect(janela.aberta).toBe(true)
    expect(permiteTextoLivre(janela)).toBe(true)
  })

  it('dado que a última entrante foi há exatamente 24h, então a janela está fechada', () => {
    const janela = calcularJanela(base, maisHoras(base, 24))
    expect(janela.aberta).toBe(false)
    expect(janela.restanteMs).toBe(0)
    expect(permiteTextoLivre(janela)).toBe(false)
  })

  it('dado que faltam 2h ou menos, então o estado é terminando', () => {
    expect(calcularJanela(base, maisHoras(base, 22)).estado).toBe('terminando')
    expect(calcularJanela(base, maisHoras(base, 22.5)).estado).toBe('terminando')
  })

  it('dado que faltam mais de 2h, então o estado é aberta', () => {
    expect(calcularJanela(base, maisHoras(base, 21.9)).estado).toBe('aberta')
  })

  it('a fração restante alimenta o anel de janela e vai de 1 a 0', () => {
    expect(calcularJanela(base, base).fracaoRestante).toBeCloseTo(1)
    expect(calcularJanela(base, maisHoras(base, 12)).fracaoRestante).toBeCloseTo(0.5)
    expect(calcularJanela(base, maisHoras(base, 24)).fracaoRestante).toBe(0)
  })

  it('dado relógio atrasado em relação à mensagem, então não devolve fração acima de 1', () => {
    // Defensivo: relógio do cliente adiantado não pode encher o anel além do trilho.
    const janela = calcularJanela(base, maisHoras(base, -1))
    expect(janela.fracaoRestante).toBeLessThanOrEqual(1.0417)
  })
})
