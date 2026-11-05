import { describe, expect, it } from 'vitest'
import {
  empilhar, mesAnterior, mesSeguinte, percentualDoOrcamento, projetarMes, rotuloMes, alertaDoOrcamento, type PontoSerie,
} from './consumo.regras.js'

const ponto = (dia: string, w: number, i: number, t: number): PontoSerie =>
  ({ dia, whatsappCentavos: w, iaCentavos: i, transcricaoCentavos: t })

describe('empilhar', () => {
  it('a barra mais alta ocupa 100% e a soma dos segmentos fecha com o total arredondado', () => {
    const { barras, maximoCentavos } = empilhar([ponto('2026-10-01', 100, 200, 100), ponto('2026-10-02', 33, 33, 33)])
    expect(maximoCentavos).toBe(400)
    expect(barras[0]!.segmentos.map((s) => s.alturaPct)).toEqual([25, 50, 25])
    for (const b of barras) {
      const soma = b.segmentos.reduce((s, x) => s + x.alturaPct, 0)
      expect(soma).toBe(Math.round((b.totalCentavos * 100) / maximoCentavos))
    }
  })
  it('série vazia ou zerada não divide por zero', () => {
    expect(empilhar([]).barras).toEqual([])
    const { barras, maximoCentavos } = empilhar([ponto('2026-10-01', 0, 0, 0)])
    expect(maximoCentavos).toBe(0)
    expect(barras[0]!.segmentos.every((s) => s.alturaPct === 0)).toBe(true)
  })
  it('rotula o dia do mês sem zero à esquerda', () => {
    expect(empilhar([ponto('2026-10-05', 1, 0, 0)]).barras[0]!.diaCurto).toBe('5')
  })
})

describe('navegação de mês', () => {
  it('vira o ano nos dois sentidos', () => {
    expect(mesAnterior('2026-01')).toBe('2025-12')
    expect(mesSeguinte('2026-12')).toBe('2027-01')
    expect(mesAnterior('2026-10')).toBe('2026-09')
    expect(rotuloMes('2026-03')).toBe('março de 2026')
  })
})

describe('projeção e alerta (compartilhados com a API)', () => {
  it('extrapola o ritmo do mês corrente; mês fechado é o gasto', () => {
    expect(projetarMes(1000, '2026-11', '2026-11-10')).toBe(3000)
    expect(projetarMes(777, '2026-10', '2026-11-10')).toBe(777)
  })
  it('selo 80 e 100 nas fronteiras', () => {
    expect(alertaDoOrcamento(79, 100)).toBeNull()
    expect(alertaDoOrcamento(80, 100)).toBe('80')
    expect(alertaDoOrcamento(100, 100)).toBe('100')
  })
  it('percentual do orçamento, inteiro, sem orçamento = null', () => {
    expect(percentualDoOrcamento(250, 1000)).toBe(25)
    expect(percentualDoOrcamento(1500, 1000)).toBe(150)
    expect(percentualDoOrcamento(10, null)).toBeNull()
  })
})
