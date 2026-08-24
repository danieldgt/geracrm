import { describe, it, expect } from 'vitest'
import {
  codigoDeBytes, codigoValido, montarTextoWaMe, extrairCodigoOrigem, TAMANHO_CODIGO,
} from './midia-origem.js'

describe('Geração do código', () => {
  it('dado bytes suficientes, então gera código do tamanho declarado', () => {
    const c = codigoDeBytes(new Uint8Array([0, 1, 2, 3, 4, 5]))
    expect(c).toHaveLength(TAMANHO_CODIGO)
    expect(codigoValido(c)).toBe(true)
  })

  it('é determinístico para os mesmos bytes', () => {
    const bytes = new Uint8Array([200, 13, 77, 4, 91, 250])
    expect(codigoDeBytes(bytes)).toBe(codigoDeBytes(bytes))
  })

  // ⚠️ O código é lido por gente numa conversa: O/0 e I/1/L não podem coexistir.
  it('nunca produz caractere ambíguo', () => {
    for (let i = 0; i < 256; i++) {
      const c = codigoDeBytes(new Uint8Array([i, i, i, i, i, i]))
      expect(c).not.toMatch(/[O0I1L]/)
    }
  })

  it('dado bytes de menos, então falha alto', () => {
    expect(() => codigoDeBytes(new Uint8Array([1, 2]))).toThrow(TypeError)
  })

  // ⚠️ O CHECK da migration 0059 é ^[A-Z0-9]{5,12}$ — o gerado tem de caber nele.
  it('o gerado satisfaz o CHECK do banco', () => {
    for (let i = 0; i < 64; i++) {
      const bytes = new Uint8Array([i, i * 3, i * 7, i * 11, i * 13, i * 17])
      expect(codigoDeBytes(bytes)).toMatch(/^[A-Z0-9]{5,12}$/)
    }
  })
})

describe('Texto pronto do wa.me', () => {
  it('põe o marcador no fim, entre colchetes', () => {
    expect(montarTextoWaMe('Olá, vi o anúncio', 'A7K2QX'))
      .toBe('Olá, vi o anúncio [ref: A7K2QX]')
  })

  it('e o que ele monta, o extrator lê de volta', () => {
    const texto = montarTextoWaMe('Quero saber sobre a coleção', 'H4M9PZ')
    expect(extrairCodigoOrigem(texto)).toBe('H4M9PZ')
  })
})

describe('Extração do código da primeira mensagem', () => {
  it('dado o formato canônico, então acha', () => {
    expect(extrairCodigoOrigem('Oi! [ref: A7K2QX]')).toBe('A7K2QX')
  })

  it('dado o marcador no meio da frase, então acha', () => {
    expect(extrairCodigoOrigem('[ref: A7K2QX] tenho interesse')).toBe('A7K2QX')
  })

  // O autocorretor do celular rebaixa maiúsculas com frequência.
  it('dado minúsculas, então normaliza', () => {
    expect(extrairCodigoOrigem('oi [ref: a7k2qx]')).toBe('A7K2QX')
  })

  it('dado que o lead apagou os colchetes, então ainda acha', () => {
    expect(extrairCodigoOrigem('Olá, vi o anúncio ref: A7K2QX')).toBe('A7K2QX')
  })

  it('dado só o código solto, então acha', () => {
    expect(extrairCodigoOrigem('bom dia A7K2QX')).toBe('A7K2QX')
  })

  // ⚠️ O caminho ESPERADO: o lead apagou tudo. Ausência não é erro.
  it('dado que o lead apagou o marcador, então null', () => {
    expect(extrairCodigoOrigem('Oi, quero saber o preço')).toBeNull()
  })

  it('dado mensagem vazia, então null', () => {
    expect(extrairCodigoOrigem('')).toBeNull()
  })

  /**
   * ⚠️ Duas candidatas soltas = ambiguidade. Chutar atribuiria a venda ao anúncio
   * errado — e o número ficaria plausível, que é pior do que não atribuir.
   */
  it('dado duas candidatas sem marcador, então null em vez de chute', () => {
    expect(extrairCodigoOrigem('vi ABCDEF e tambem QRSTUV')).toBeNull()
  })

  it('mas com o marcador canônico presente, a ambiguidade some', () => {
    expect(extrairCodigoOrigem('vi ABCDEF e [ref: QRSTUV]')).toBe('QRSTUV')
  })

  it('dado palavra de 6 letras com caractere ambíguo, então não confunde com código', () => {
    // 'MOLDES' tem O e L — fora do alfabeto, então não é candidata.
    expect(extrairCodigoOrigem('quero ver MOLDES')).toBeNull()
  })
})
