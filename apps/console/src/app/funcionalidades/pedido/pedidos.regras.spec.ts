import { describe, it, expect } from 'vitest'
import {
  rotuloDoEstado, tomDoEstado, variacaoDaGrade, indicadoresDaLista, filtrarPorTermo,
} from './pedidos.regras.js'

describe('pedidos: rótulo e tom por estado', () => {
  it('nomeia o estado para o operador', () => {
    expect(rotuloDoEstado('efetivado')).toBe('No ERP')
    expect(rotuloDoEstado('aguardando_confirmacao')).toBe('Aguardando SIM')
    expect(rotuloDoEstado('estado_novo')).toBe('estado_novo')
  })

  it('o que pede atenção ganha tom de alerta; o que deu certo, de sucesso', () => {
    expect(tomDoEstado('falhou')).toBe('erro')
    expect(tomDoEstado('aguardando_conferencia')).toBe('atencao')
    expect(tomDoEstado('efetivado')).toBe('sucesso')
    expect(tomDoEstado('confirmado')).toBe('info')
    expect(tomDoEstado('rascunho')).toBe('neutro')
    expect(tomDoEstado('desconhecido')).toBe('neutro')
  })
})

describe('pedidos: variação da grade', () => {
  it('cor, tamanho e subTamanho primeiro, depois o resto', () => {
    expect(variacaoDaGrade({ tamanho: 'M', extra: 'x', cor: 'Azul' })).toBe('Azul · M · x')
  })

  it('vazio vira texto vazio', () => {
    expect(variacaoDaGrade(null)).toBe('')
    expect(variacaoDaGrade({ cor: '' })).toBe('')
  })
})

describe('pedidos: cards sobre o carregado', () => {
  it('conta por estado e soma o valor só dos efetivados, em centavos inteiros', () => {
    const r = indicadoresDaLista([
      { estado: 'efetivado', totalCentavos: 10050 },
      { estado: 'efetivado', totalCentavos: 2000 },
      { estado: 'rascunho', totalCentavos: 9999 },
      { estado: 'falhou', totalCentavos: 500 },
      { estado: 'confirmado', totalCentavos: 700 },
    ])
    expect(r).toEqual({ efetivados: 2, valorEfetivadoCentavos: 12050, rascunhos: 1, falharam: 1 })
  })

  it('lista vazia zera tudo', () => {
    expect(indicadoresDaLista([])).toEqual({ efetivados: 0, valorEfetivadoCentavos: 0, rascunhos: 0, falharam: 0 })
  })
})

describe('pedidos: busca no carregado', () => {
  const itens = [
    { contato: 'Loja Ana', rotulo: 'Inverno', numeroExterno: '4411' },
    { contato: null, rotulo: null, numeroExterno: null },
    { contato: 'Mercado Central', rotulo: null, numeroExterno: 'NF-99' },
  ]

  it('termo vazio devolve tudo', () => {
    expect(filtrarPorTermo(itens, '   ')).toHaveLength(3)
  })

  it('casa cliente, nome do pedido ou nº ERP, sem diferenciar maiúscula', () => {
    expect(filtrarPorTermo(itens, 'ANA')).toEqual([itens[0]])
    expect(filtrarPorTermo(itens, 'inverno')).toEqual([itens[0]])
    expect(filtrarPorTermo(itens, 'nf-9')).toEqual([itens[2]])
  })

  it('sem casamento devolve lista vazia', () => {
    expect(filtrarPorTermo(itens, 'zzz')).toEqual([])
  })
})
