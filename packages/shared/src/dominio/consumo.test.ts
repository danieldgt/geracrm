import { describe, it, expect } from 'vitest'
import { variaveisDoCorpo, validarMapeamento, projetarMes, alertaDoOrcamento, diasDoMes } from './consumo.js'

describe('variaveisDoCorpo', () => {
  it('acha {{n}} únicos, em ordem, tolerando espaços', () => {
    expect(variaveisDoCorpo('Olá {{2}}, {{ 1 }} e de novo {{2}}')).toEqual([1, 2])
    expect(variaveisDoCorpo('sem variáveis {nome}')).toEqual([])
  })
})

describe('validarMapeamento', () => {
  it('aceita campos da lista para variáveis que existem', () => {
    expect(validarMapeamento({ '1': 'contato.nome', '2': 'vendedor.nome' }, [1, 2])).toBeNull()
  })
  it('recusa campo fora da lista e variável que o corpo não tem', () => {
    expect(validarMapeamento({ '1': 'contato.cpf' }, [1])).toEqual({ motivo: 'campo_invalido', variavel: '1' })
    expect(validarMapeamento({ '3': 'contato.nome' }, [1])).toEqual({ motivo: 'variavel_inexistente', variavel: '3' })
    expect(validarMapeamento({ x: 'contato.nome' }, [1])).toEqual({ motivo: 'variavel_inexistente', variavel: 'x' })
  })
})

describe('projetarMes', () => {
  it('extrapola o ritmo do mês corrente', () => {
    expect(projetarMes(1000, '2026-11', '2026-11-10')).toBe(3000)
    expect(diasDoMes('2026-02')).toBe(28)
  })
  it('mês passado é o gasto; futuro é zero', () => {
    expect(projetarMes(1234, '2026-10', '2026-11-10')).toBe(1234)
    expect(projetarMes(50, '2026-12', '2026-11-10')).toBe(0)
  })
})

describe('alertaDoOrcamento', () => {
  it('80 e 100 nas fronteiras, sem orçamento nada', () => {
    expect(alertaDoOrcamento(79, 100)).toBeNull()
    expect(alertaDoOrcamento(80, 100)).toBe('80')
    expect(alertaDoOrcamento(99, 100)).toBe('80')
    expect(alertaDoOrcamento(100, 100)).toBe('100')
    expect(alertaDoOrcamento(500, null)).toBeNull()
  })
})
