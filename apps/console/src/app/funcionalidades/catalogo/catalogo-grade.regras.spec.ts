import { describe, it, expect } from 'vitest'
import { corClara, montarGrade, rankTamanho, saldoDaLinha, type SkuDaGrade } from './catalogo-grade.regras.js'

const sku = (cor: string, tamanho: string, saldo: number | null = 1): SkuDaGrade =>
  ({ atributos: { cor, tamanho }, precoCentavos: 1000, saldo })

describe('grade cor × tamanho', () => {
  it('pivota as linhas planas e soma por cor, por tamanho e no total', () => {
    const g = montarGrade([sku('PRETO', 'M', 2), sku('PRETO', 'G', 3), sku('AZUL', 'M', 5)])
    expect(g.temGrade).toBe(true)
    expect(g.cores.map((c) => c.nome)).toEqual(['AZUL', 'PRETO'])
    expect(g.totalCor).toEqual({ AZUL: 5, PRETO: 5 })
    expect(g.totalTam).toEqual({ M: 7, G: 3 })
    expect(g.total).toBe(10)
  })

  it('combinação inexistente fica fora da matriz (a tela mostra —, não 0)', () => {
    const g = montarGrade([sku('PRETO', 'M'), sku('AZUL', 'G')])
    expect(g.celulas['PRETO||G']).toBeUndefined()
    expect(g.celulas['PRETO||M']).toBeDefined()
  })

  it('tamanhos por rank: único, letras, números, resto', () => {
    const g = montarGrade([sku('X', '42'), sku('X', 'G'), sku('X', 'PP'), sku('X', 'U'), sku('X', '38')])
    expect(g.tamanhos).toEqual(['U', 'PP', 'G', '38', '42'])
    expect(rankTamanho('gg')[0]).toBe(1)
  })

  it('atributo com qualquer caixa conta; sem cor ou sem tamanho não há grade', () => {
    expect(montarGrade([{ atributos: { COR: 'PRETO', Tamanho: 'M' }, precoCentavos: null, saldo: 1 }]).temGrade).toBe(true)
    expect(montarGrade([{ atributos: { ciclo: 'mensal' }, precoCentavos: null, saldo: 1 }]).temGrade).toBe(false)
  })
})

describe('saldo na linha da lista', () => {
  it('soma a grade, ou os SKUs sem grade', () => {
    expect(saldoDaLinha([sku('PRETO', 'M', 2), sku('PRETO', 'G', 3)])).toBe('5')
    expect(saldoDaLinha([{ atributos: {}, precoCentavos: null, saldo: 4 }, { atributos: {}, precoCentavos: null, saldo: 1 }])).toBe('5')
  })
  it('? quando algum SKU sem grade não sincronizou; sob demanda quando nenhum controla estoque', () => {
    expect(saldoDaLinha([{ atributos: {}, precoCentavos: null, saldo: 4 }, { atributos: {}, precoCentavos: null, saldo: null }])).toBe('?')
    expect(saldoDaLinha([{ atributos: {}, precoCentavos: null, saldo: null }])).toBe('sob demanda')
    expect(saldoDaLinha([])).toBe('—')
  })
})

describe('swatch', () => {
  it('cor clara ganha borda; escura não', () => {
    expect(corClara('#FFFFFF')).toBe(true)
    expect(corClara('#1A1A1A')).toBe(false)
  })
})
