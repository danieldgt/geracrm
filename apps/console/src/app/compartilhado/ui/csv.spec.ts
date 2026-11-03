// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { baixarCsv, paraCsv } from './csv.js'

const BOM = '﻿'
const cols = [{ chave: 'nome', rotulo: 'Nome' }, { chave: 'total', rotulo: 'Total' }]

describe('paraCsv', () => {
  it('começa com BOM UTF-8, separa por ponto e vírgula e termina cada linha com CRLF', () => {
    const r = paraCsv(cols, [{ nome: 'Ana', total: 10 }])
    expect(r).toBe(`${BOM}Nome;Total\r\nAna;10\r\n`)
  })
  it('sem linhas, devolve só o cabeçalho', () => {
    expect(paraCsv(cols, [])).toBe(`${BOM}Nome;Total\r\n`)
  })
  it('escapa aspas duplas dobrando-as e envolve o campo', () => {
    expect(paraCsv(cols, [{ nome: 'Loja "Boa"', total: 1 }])).toContain('"Loja ""Boa""";1')
  })
  it('campo com separador é envolvido em aspas', () => {
    expect(paraCsv(cols, [{ nome: 'a;b', total: 1 }])).toContain('"a;b";1')
  })
  it('quebra de linha dentro do campo fica entre aspas, sem partir a linha do CSV', () => {
    const r = paraCsv(cols, [{ nome: 'linha1\nlinha2', total: 1 }])
    expect(r).toContain('"linha1\nlinha2";1\r\n')
  })
  it('null e undefined viram campo vazio; booleano vira texto', () => {
    expect(paraCsv([...cols, { chave: 'ok', rotulo: 'Ok' }], [{ nome: null, total: undefined, ok: true }]))
      .toContain('\r\n;;true\r\n')
  })
  it('número usa vírgula decimal por padrão e ponto quando pedido', () => {
    expect(paraCsv(cols, [{ nome: 'x', total: 12.5 }])).toContain('x;12,5')
    expect(paraCsv(cols, [{ nome: 'x', total: 12.5 }], { virgulaDecimal: false })).toContain('x;12.5')
  })
  it('vírgula decimal não mexe em texto que parece número', () => {
    expect(paraCsv(cols, [{ nome: '1.5', total: 1 }])).toContain('1.5;1')
  })
  it('rótulo do cabeçalho também é escapado', () => {
    expect(paraCsv([{ chave: 'a', rotulo: 'A;B' }], [])).toBe(`${BOM}"A;B"\r\n`)
  })
  it('chave ausente na linha vira vazio', () => {
    expect(paraCsv(cols, [{ nome: 'x' }])).toContain('x;\r\n')
  })
})

describe('injeção de fórmula e identificadores longos', () => {
  const linha = (nome: unknown, total: unknown = 1) => paraCsv(cols, [{ nome, total }])
  it.each(['=1+1', '+55 11', '-2+3', '@SOMA(A1)', '\tcmd', '\rcmd'])('texto %j começa com apóstrofo', (t) => {
    expect(linha(t)).toContain(`'${t}`)
  })
  it('número real negativo não é prefixado', () => {
    expect(linha('x', -5)).toContain('x;-5')
    expect(linha('x', -5.5)).toContain('x;-5,5')
  })
  it('texto comum não muda', () => {
    expect(linha('Ana')).toContain('\r\nAna;1')
  })
  it('string só de dígitos com 11+ caracteres sai como texto preservado', () => {
    expect(linha('12345678000190')).toContain("'12345678000190;1")
    expect(linha('00123456789')).toContain("'00123456789;1")
  })
  it('string de dígitos curta e número grande não são prefixados', () => {
    expect(linha('1234567890')).toContain('\r\n1234567890;1')
    expect(linha('x', 12345678901)).toContain('x;12345678901')
  })
})

describe('baixarCsv', () => {
  it('anexa a âncora ao DOM no clique e revoga a URL só depois (setTimeout)', () => {
    vi.useFakeTimers()
    const revogar = vi.fn()
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: revogar })
    let noDom = false
    const clique = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      noDom = document.body.contains(this)
    })
    baixarCsv('lista', 'a;b')
    expect(noDom).toBe(true)
    expect(revogar).not.toHaveBeenCalled()
    vi.runAllTimers()
    expect(revogar).toHaveBeenCalledWith('blob:x')
    expect(document.querySelector('a[download]')).toBeNull()
    clique.mockRestore()
    vi.useRealTimers()
  })
})
