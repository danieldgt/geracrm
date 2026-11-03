import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  estadoSelecaoPagina, alternarPagina, alternarChave, textoMostrando, textoSelecionados, textoDaCelula, comDebounce,
} from './lista.regras.js'

describe('seleção da página', () => {
  const pagina = ['a', 'b', 'c']
  it('nenhum / parcial / todos', () => {
    expect(estadoSelecaoPagina(new Set(), pagina)).toBe('nenhum')
    expect(estadoSelecaoPagina(new Set(['a']), pagina)).toBe('parcial')
    expect(estadoSelecaoPagina(new Set(pagina), pagina)).toBe('todos')
  })
  it('página vazia é nenhum (checkbox não fica marcado)', () => {
    expect(estadoSelecaoPagina(new Set(['x']), [])).toBe('nenhum')
  })
  it('seleção de outra página não conta', () => {
    expect(estadoSelecaoPagina(new Set(['x', 'y']), pagina)).toBe('nenhum')
  })
  it('alternar a partir de parcial marca tudo; a partir de todos desmarca só a página', () => {
    const marcado = alternarPagina(new Set(['a', 'x']), pagina)
    expect([...marcado].sort()).toEqual(['a', 'b', 'c', 'x'])
    const limpo = alternarPagina(marcado, pagina)
    expect([...limpo]).toEqual(['x'])
  })
  it('alternarChave não muta o original', () => {
    const o = new Set(['a'])
    expect([...alternarChave(o, 'b')].sort()).toEqual(['a', 'b'])
    expect([...alternarChave(o, 'a')]).toEqual([])
    expect([...o]).toEqual(['a'])
  })
})

describe('textos', () => {
  it('mostrando', () => {
    expect(textoMostrando(25)).toBe('Mostrando 25')
    expect(textoMostrando(25, null)).toBe('Mostrando 25')
    expect(textoMostrando(25, 120)).toBe('Mostrando 25 de 120')
    expect(textoMostrando(0, 0)).toBe('Mostrando 0 de 0')
  })
  it('selecionados no singular e plural', () => {
    expect(textoSelecionados(1)).toBe('1 selecionado')
    expect(textoSelecionados(3)).toBe('3 selecionados')
  })
  it('célula padrão', () => {
    expect(textoDaCelula(null)).toBe('')
    expect(textoDaCelula(0)).toBe('0')
  })
})

describe('comDebounce', () => {
  afterEach(() => vi.useRealTimers())
  it('dispara uma vez só, com o último valor, após o intervalo', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const d = comDebounce(fn, 300)
    d('a'); vi.advanceTimersByTime(200); d('ab'); vi.advanceTimersByTime(299)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith('ab')
  })
  it('cancelar impede o disparo pendente', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const d = comDebounce(fn, 300)
    d('a'); d.cancelar(); vi.advanceTimersByTime(1000)
    expect(fn).not.toHaveBeenCalled()
  })
})
