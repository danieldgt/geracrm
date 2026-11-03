import { describe, it, expect } from 'vitest'
import {
  atributosAria, centavosParaTexto, idDica, idErro, proximoIdCampo, textoDoValor, valorDoControle,
} from './campo.regras.js'

describe('ids e ARIA do campo', () => {
  it('cada instância ganha id único (rótulo for/id)', () => {
    expect(proximoIdCampo('x')).not.toBe(proximoIdCampo('x'))
  })

  it('obrigatório vira aria-required (o asterisco é só visual)', () => {
    const a = atributosAria({ id: 'c1', erro: null, dica: '', obrigatorio: true })
    expect(a.ariaRequired).toBe('true')
    expect(atributosAria({ id: 'c1', erro: null, dica: '', obrigatorio: false }).ariaRequired).toBeNull()
  })

  it('erro vira aria-invalid e aponta para a mensagem; dica também descreve', () => {
    const a = atributosAria({ id: 'c1', erro: 'Obrigatório', dica: 'Ajuda', obrigatorio: false })
    expect(a.ariaInvalid).toBe('true')
    expect(a.ariaDescribedBy).toBe(`${idErro('c1')} ${idDica('c1')}`)
  })

  it('sem erro nem dica não há describedby nem invalid', () => {
    const a = atributosAria({ id: 'c1', erro: null, dica: '', obrigatorio: false })
    expect(a).toEqual({ ariaInvalid: null, ariaRequired: null, ariaDescribedBy: null })
  })
})

describe('dinheiro no campo: "1.234,56" e centavos', () => {
  it('digitado vira centavos inteiros', () => {
    expect(valorDoControle('dinheiro', '1.234,56')).toBe(123456)
    expect(valorDoControle('dinheiro', '0,99')).toBe(99)
    expect(valorDoControle('dinheiro', '')).toBeNull()
    expect(valorDoControle('dinheiro', 'abc')).toBeNull()
  })
  it('centavos viram texto com milhar', () => {
    expect(centavosParaTexto(123456)).toBe('1.234,56')
    expect(centavosParaTexto(5)).toBe('0,05')
    expect(centavosParaTexto(123456789)).toBe('1.234.567,89')
    expect(centavosParaTexto(null)).toBe('')
    expect(textoDoValor('dinheiro', 123456)).toBe('1.234,56')
  })
})

describe('outros tipos', () => {
  it('number devolve número ou null', () => {
    expect(valorDoControle('number', '12')).toBe(12)
    expect(valorDoControle('number', '')).toBeNull()
    expect(valorDoControle('text', 'oi')).toBe('oi')
  })
  it('texto do valor tolera null', () => {
    expect(textoDoValor('text', null)).toBe('')
    expect(textoDoValor('number', 7)).toBe('7')
  })
})
