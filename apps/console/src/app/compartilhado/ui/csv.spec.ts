import { describe, it, expect } from 'vitest'
import { paraCsv } from './csv.js'

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
  it('número usa ponto por padrão e vírgula decimal quando pedido', () => {
    expect(paraCsv(cols, [{ nome: 'x', total: 12.5 }])).toContain('x;12.5')
    expect(paraCsv(cols, [{ nome: 'x', total: 12.5 }], { virgulaDecimal: true })).toContain('x;12,5')
  })
  it('vírgula decimal não mexe em texto que parece número', () => {
    expect(paraCsv(cols, [{ nome: '1.5', total: 1 }], { virgulaDecimal: true })).toContain('1.5;1')
  })
  it('rótulo do cabeçalho também é escapado', () => {
    expect(paraCsv([{ chave: 'a', rotulo: 'A;B' }], [])).toBe(`${BOM}"A;B"\r\n`)
  })
  it('chave ausente na linha vira vazio', () => {
    expect(paraCsv(cols, [{ nome: 'x' }])).toContain('x;\r\n')
  })
})
