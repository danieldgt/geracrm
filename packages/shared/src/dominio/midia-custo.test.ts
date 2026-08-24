import { describe, it, expect } from 'vitest'
import { microsParaCentavos, decimalParaCentavos, somarCentavos, calcularRoas } from './midia-custo.js'

describe('Google — micros para centavos', () => {
  it('dado 1 unidade em micros, então são 100 centavos', () => {
    expect(microsParaCentavos(1_000_000)).toBe(100)
  })

  it('dado zero, então zero', () => {
    expect(microsParaCentavos(0)).toBe(0)
  })

  // ⚠️ A fronteira: micros que NÃO caem em centavo exato.
  it('dado micros com fração de centavo, então arredonda — não trunca', () => {
    expect(microsParaCentavos(12_345_678)).toBe(1235) // 1234,5678 → 1235
    expect(microsParaCentavos(4_999)).toBe(0)         // 0,4999 → 0
    expect(microsParaCentavos(5_000)).toBe(1)         // 0,5 → 1
  })

  it('dado bigint (como o driver devolve), então converte igual', () => {
    expect(microsParaCentavos(1_000_000n)).toBe(100)
  })

  it('dado valor não finito, então falha alto', () => {
    expect(() => microsParaCentavos(Number.NaN)).toThrow(TypeError)
  })
})

describe('Meta — decimal em texto para centavos', () => {
  it('dado "12.34", então 1234 centavos', () => {
    expect(decimalParaCentavos('12.34')).toBe(1234)
  })

  /**
   * ⚠️ O caso que motiva o módulo inteiro. Nem todo decimal quebra no float —
   * `12.34 * 100` dá 1234 redondo. Mas `8.29 * 100` dá 828.9999999999999, e um
   * `Math.floor` ali cobraria um centavo a menos. O erro é INTERMITENTE: aparece
   * em alguns valores e não em outros, que é o que o torna difícil de achar
   * depois. Converter pelo TEXTO remove a categoria inteira do problema.
   */
  it.each([
    ['0.29', 29], ['8.29', 829], ['1.15', 115], ['2.55', 255], ['4.35', 435], ['16.08', 1608],
  ])('dado %j — valor onde o float erra —, então %i centavos', (texto, esperado) => {
    expect(decimalParaCentavos(texto as string)).toBe(esperado)
    // Prova de que a armadilha é real neste valor:
    expect(Math.floor(parseFloat(texto as string) * 100)).toBe((esperado as number) - 1)
  })

  it('dado inteiro sem parte decimal, então multiplica por 100', () => {
    expect(decimalParaCentavos('12')).toBe(1200)
  })

  it('dado um só dígito decimal, então completa o centavo', () => {
    expect(decimalParaCentavos('12.3')).toBe(1230)
  })

  it('dado mais de dois decimais, então arredonda o resto', () => {
    expect(decimalParaCentavos('12.345')).toBe(1235)
    expect(decimalParaCentavos('12.344')).toBe(1234)
  })

  it('dado valor negativo, então preserva o sinal', () => {
    expect(decimalParaCentavos('-1.50')).toBe(-150)
  })

  it('dado espaços em volta, então tolera', () => {
    expect(decimalParaCentavos('  7.05 ')).toBe(705)
  })

  // ⚠️ Falhar alto é melhor que converter errado: formato inesperado significa
  // que a origem mudou, e um número plausível esconderia isso.
  it.each(['1e3', '12,34', 'R$ 12', '', 'abc'])('dado %j, então recusa', (v) => {
    expect(() => decimalParaCentavos(v)).toThrow(TypeError)
  })
})

describe('Soma de centavos', () => {
  it('dado bigint como string (o driver), então soma como número', () => {
    // ⚠️ Sem esta função, "2" + "3" seria "23".
    expect(somarCentavos(['2', '3'])).toBe(5)
  })

  it('dado tipos misturados, então soma', () => {
    expect(somarCentavos([100, '250', 50n])).toBe(400)
  })

  it('dado lista vazia, então zero', () => {
    expect(somarCentavos([])).toBe(0)
  })

  it('dado valor não numérico, então falha alto', () => {
    expect(() => somarCentavos(['doze'])).toThrow(TypeError)
  })
})

describe('ROAS', () => {
  it('dado receita e custo, então a razão', () => {
    expect(calcularRoas(30_000, 10_000)).toBe(3)
  })

  // ⚠️ Infinity numa tela vira "∞" e numa soma contamina tudo.
  it('dado custo zero, então null — nunca Infinity', () => {
    expect(calcularRoas(30_000, 0)).toBeNull()
    expect(calcularRoas(0, 0)).toBeNull()
  })
})
