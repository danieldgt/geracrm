import { describe, it, expect } from 'vitest'
import { estadoContraMeta, faltamParaMeta, montarIndicador, percentualComProximoPasso } from './carteira-higienizacao.js'

describe('higienização da carteira', () => {
  it('percentual com uma casa e sem ativos = 100', () => {
    expect(percentualComProximoPasso(3, 2)).toBe(66.7)
    expect(percentualComProximoPasso(0, 0)).toBe(100)
    expect(percentualComProximoPasso(10, 15)).toBe(100)
  })
  it('estado contra a meta de 95', () => {
    expect(estadoContraMeta(95)).toBe('atingida')
    expect(estadoContraMeta(94.9)).toBe('atencao')
    expect(estadoContraMeta(80)).toBe('atencao')
    expect(estadoContraMeta(79.9)).toBe('critica')
  })
  it('faltam para a meta', () => {
    expect(faltamParaMeta(100, 90)).toBe(5)
    expect(faltamParaMeta(100, 96)).toBe(0)
    expect(faltamParaMeta(0, 0)).toBe(0)
  })
  it('monta o indicador', () => {
    expect(montarIndicador(4, 1)).toEqual({ ativos: 4, comProximoPasso: 1, semProximoPasso: 3, percentual: 25, meta: 95 })
  })
})
