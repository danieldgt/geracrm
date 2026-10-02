import { describe, it, expect } from 'vitest'
import { centavosParaReais, reaisParaCentavos } from './dinheiro.js'

describe('reaisParaCentavos — o que a pessoa digita vira centavos inteiros', () => {
  it.each([
    ['1.234,56', 123456],
    ['1234,56', 123456],
    ['1234,5', 123450],
    ['1234', 123400],
    ['0,99', 99],
    ['R$ 12,00', 1200],
    [' 7 ', 700],
    ['12.50', 1250],
    ['12.5', 1250],
    ['1.234', 123400],
    ['1.234.567', 123456700],
    ['0', 0],
  ])('%s → %i', (texto, esperado) => {
    expect(reaisParaCentavos(texto)).toBe(esperado)
  })

  it('⚠️ não passa por float: 12,34 é exatamente 1234', () => {
    expect(reaisParaCentavos('12,34')).toBe(1234)
    expect(reaisParaCentavos('0,29')).toBe(29)
  })

  it.each(['', '   ', 'abc', '12,345', '-5', '1,2,3', '1e3', ','])('inválido: %j → null', (texto) => {
    expect(reaisParaCentavos(texto)).toBeNull()
  })
})

describe('centavosParaReais — preencher o campo de edição', () => {
  it('formata sem milhar, com dois decimais', () => {
    expect(centavosParaReais(123456)).toBe('1234,56')
    expect(centavosParaReais(5)).toBe('0,05')
    expect(centavosParaReais(0)).toBe('0,00')
    expect(centavosParaReais(-150)).toBe('-1,50')
  })
  it('sem valor → campo vazio', () => {
    expect(centavosParaReais(null)).toBe('')
    expect(centavosParaReais(undefined)).toBe('')
  })
  it('ida e volta é identidade', () => {
    for (const c of [0, 1, 99, 100, 123456, 99999999]) expect(reaisParaCentavos(centavosParaReais(c))).toBe(c)
  })
})
