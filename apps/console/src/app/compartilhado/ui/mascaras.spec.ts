// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import {
  formatarCpf, formatarCnpj, formatarCpfCnpj, formatarTelefone, formatarCep, soDigitos, digitosDaMascara,
  posicaoDoCursor, aplicarMascaraNoElemento,
} from './mascaras.js'

describe('máscaras — ida (exibir) e volta (só dígitos)', () => {
  it('vazio e lixo não quebram', () => {
    for (const f of [formatarCpf, formatarCnpj, formatarCpfCnpj, formatarTelefone, formatarCep]) {
      expect(f('')).toBe('')
      expect(f('abc')).toBe('')
    }
  })

  it('CPF parcial vai ganhando pontuação sem sobra pendurada', () => {
    expect(formatarCpf('123')).toBe('123')
    expect(formatarCpf('1234')).toBe('123.4')
    expect(formatarCpf('123456789')).toBe('123.456.789')
    expect(formatarCpf('1234567890')).toBe('123.456.789-0')
    expect(formatarCpf('12345678901')).toBe('123.456.789-01')
    expect(formatarCpf('123456789012345')).toBe('123.456.789-01')
  })

  it('colado com pontuação resolve igual', () => {
    expect(formatarCpf('123.456.789-01')).toBe('123.456.789-01')
    expect(formatarCnpj('12.345.678/0001-95')).toBe('12.345.678/0001-95')
    expect(digitosDaMascara('cnpj', '12.345.678/0001-95')).toBe('12345678000195')
    expect(soDigitos('12.345.678/0001-95')).toBe('12345678000195')
  })

  it('CNPJ completo e parcial', () => {
    expect(formatarCnpj('12')).toBe('12')
    expect(formatarCnpj('123')).toBe('12.3')
    expect(formatarCnpj('12345678')).toBe('12.345.678')
    expect(formatarCnpj('123456780001')).toBe('12.345.678/0001')
    expect(formatarCnpj('12345678000195')).toBe('12.345.678/0001-95')
  })

  it('cpfCnpj troca de molde no 12º dígito', () => {
    expect(formatarCpfCnpj('12345678901')).toBe('123.456.789-01')
    expect(formatarCpfCnpj('123456789012')).toBe('12.345.678/9012')
    expect(formatarCpfCnpj('12345678000195')).toBe('12.345.678/0001-95')
  })

  it('CEP', () => {
    expect(formatarCep('01310')).toBe('01310')
    expect(formatarCep('013101')).toBe('01310-1')
    expect(formatarCep('01310-100')).toBe('01310-100')
    expect(formatarCep('0131010099')).toBe('01310-100')
  })

  it('telefone fixo (10) e celular (11)', () => {
    expect(formatarTelefone('8')).toBe('(8')
    expect(formatarTelefone('85')).toBe('(85')
    expect(formatarTelefone('859')).toBe('(85) 9')
    expect(formatarTelefone('8532221234')).toBe('(85) 3222-1234')
    expect(formatarTelefone('85998617049')).toBe('(85) 99861-7049')
    expect(formatarTelefone('859986170491234')).toBe('(85) 99861-7049')
  })

  it('telefone com 55 (12 e 13 dígitos)', () => {
    expect(formatarTelefone('558532221234')).toBe('+55 (85) 3222-1234')
    expect(formatarTelefone('5585998617049')).toBe('+55 (85) 99861-7049')
    expect(formatarTelefone('+55 (85) 99861-7049')).toBe('+55 (85) 99861-7049')
  })

  it('DDD 55 sem DDI não é confundido com país', () => {
    expect(formatarTelefone('55999887766')).toBe('(55) 99988-7766')
  })

  it('ida e volta é estável (idempotente)', () => {
    for (const [tipo, f, v] of [
      ['cpf', formatarCpf, '12345678901'], ['cnpj', formatarCnpj, '12345678000195'],
      ['telefone', formatarTelefone, '85998617049'], ['cep', formatarCep, '01310100'],
    ] as const) {
      expect(f(f(v))).toBe(f(v))
      expect(digitosDaMascara(tipo, f(v))).toBe(v)
    }
  })
})

describe('posicaoDoCursor', () => {
  it('meio do texto: digitar no meio mantém o cursor após o dígito digitado', () => {
    const novo = formatarCpf('1923456')
    expect(novo).toBe('192.345.6')
    expect(posicaoDoCursor('1923.456', 3, novo)).toBe(3)
    expect(posicaoDoCursor('1234', 4, formatarCpf('1234'))).toBe(5)
  })
  it('apagar: cursor fica colado ao dígito anterior', () => {
    expect(posicaoDoCursor('123.56', 4, formatarCpf('12356'))).toBe(3)
  })
  it('colar: cursor vai ao fim do que foi colado, truncado ao limite', () => {
    const novo = formatarCpf('12345678901999')
    expect(posicaoDoCursor('12345678901999', 14, novo)).toBe(novo.length)
  })
  it('sem dígitos à esquerda é 0; caret fora do intervalo não quebra', () => {
    expect(posicaoDoCursor('abc', 3, '')).toBe(0)
    expect(posicaoDoCursor('12', 99, '12')).toBe(2)
    expect(posicaoDoCursor('12', -5, '12')).toBe(0)
  })
})

describe('aplicarMascaraNoElemento', () => {
  function input(valor: string, caret: number): HTMLInputElement {
    const el = document.createElement('input')
    document.body.appendChild(el)
    el.focus()
    el.value = valor
    el.setSelectionRange(caret, caret)
    return el
  }
  it('sobra "123a" some da tela mesmo quando o valor formatado não muda', () => {
    const el = input('123.456.789-01a', 15)
    aplicarMascaraNoElemento(el, 'cpf', true)
    expect(el.value).toBe('123.456.789-01')
  })
  it('digitar no meio não joga o cursor para o fim', () => {
    const el = input('1923.456', 3)
    aplicarMascaraNoElemento(el, 'cpf', true)
    expect(el.value).toBe('192.345.6')
    expect(el.selectionStart).toBe(3)
  })
  it('DDD 55 (RS) digitando: não vira +55 até 12 dígitos', () => {
    let texto = ''
    for (const d of '55987654321') {
      texto += d
      const el = input(texto, texto.length)
      texto = aplicarMascaraNoElemento(el, 'telefone', true)
      expect(texto.startsWith('+')).toBe(false)
      expect(el.selectionStart).toBe(texto.length)
    }
    expect(texto).toBe('(55) 98765-4321')
  })
})
