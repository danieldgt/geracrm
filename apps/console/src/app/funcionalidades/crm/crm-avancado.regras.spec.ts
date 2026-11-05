import { describe, it, expect } from 'vitest'
import { colunaDeFrequencia } from './crm-avancado.regras.js'

describe('Por nº de pedidos — colunas', () => {
  it('mostra os baldes de frequência e representantes', () => {
    expect(['p1', 'p2', 'p3', 'representantes'].every(colunaDeFrequencia)).toBe(true)
  })
  it('esconde a qualificação (leads e descartados), que mora no Funil', () => {
    expect(colunaDeFrequencia('leads')).toBe(false)
    expect(colunaDeFrequencia('descartados')).toBe(false)
  })
})
