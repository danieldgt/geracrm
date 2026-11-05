import { describe, it, expect } from 'vitest'
import {
  rotuloDoEstado, tomDoEstado, variacaoDaGrade, indicadoresDosContadores, montarQueryPedidos, abasDeEstado, ABA_TODOS,
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

describe('pedidos: cards a partir dos contadores do servidor', () => {
  it('lê quantidade e valor por estado, em centavos inteiros', () => {
    const r = indicadoresDosContadores({
      porEstado: { efetivado: { quantidade: 2, valorCentavos: 12050 }, rascunho: { quantidade: 1, valorCentavos: 9999 }, falhou: { quantidade: 1, valorCentavos: 500 } },
      total: 4, valorTotalCentavos: 22549,
    })
    expect(r).toEqual({ efetivados: 2, valorEfetivadoCentavos: 12050, rascunhos: 1, falharam: 1 })
  })

  it('estado ausente conta zero', () => {
    expect(indicadoresDosContadores({ porEstado: {}, total: 0, valorTotalCentavos: 0 }))
      .toEqual({ efetivados: 0, valorEfetivadoCentavos: 0, rascunhos: 0, falharam: 0 })
  })
})

describe('pedidos: query do servidor', () => {
  it('vazio some e a busca é aparada', () => {
    expect(montarQueryPedidos({ q: '   ' }).toString()).toBe('')
    expect(montarQueryPedidos({ q: '  ana ', estado: 'efetivado' }).toString()).toBe('estado=efetivado&q=ana')
  })

  it('período só vai com os dois extremos', () => {
    expect(montarQueryPedidos({ inicio: '2026-11-01' }).has('inicio')).toBe(false)
    const p = montarQueryPedidos({ inicio: '2026-11-01', fim: '2026-11-03', cursor: 'abc' })
    expect(p.get('inicio')).toBe('2026-11-01'); expect(p.get('fim')).toBe('2026-11-03'); expect(p.get('cursor')).toBe('abc')
  })
})

describe('pedidos: abas de estado com a contagem no rótulo', () => {
  it('sem contadores, nenhuma aba mostra número (nunca zero falso)', () => {
    const abas = abasDeEstado(null)
    expect(abas[0]).toEqual({ id: ABA_TODOS, rotulo: 'Todos' })
    expect(abas.every((a) => a.contador === undefined)).toBe(true)
  })

  it('com contadores: Todos = total, estado ausente = 0', () => {
    const abas = abasDeEstado({ porEstado: { falhou: { quantidade: 2, valorCentavos: 100 } }, total: 9, valorTotalCentavos: 100 })
    expect(abas.find((a) => a.id === ABA_TODOS)?.contador).toBe(9)
    expect(abas.find((a) => a.id === 'falhou')?.contador).toBe(2)
    expect(abas.find((a) => a.id === 'rascunho')?.contador).toBe(0)
  })
})
