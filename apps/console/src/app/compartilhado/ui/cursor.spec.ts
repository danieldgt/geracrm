import { describe, it, expect } from 'vitest'
import { mesclarPagina, queryDeLista } from './cursor.js'

interface Item { id: string; nome: string }
const i = (id: string): Item => ({ id, nome: id })

describe('mesclarPagina — carregar mais sem duplicata', () => {
  it('anexa a página seguinte mantendo a ordem', () => {
    const r = mesclarPagina([i('a'), i('b')], [i('c'), i('d')], (x) => x.id)
    expect(r.map((x) => x.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('⚠️ item que já está na tela não entra de novo (a lista andou entre as páginas)', () => {
    const r = mesclarPagina([i('a'), i('b')], [i('b'), i('c')], (x) => x.id)
    expect(r.map((x) => x.id)).toEqual(['a', 'b', 'c'])
  })

  it('não altera a lista original', () => {
    const atual = [i('a')]
    mesclarPagina(atual, [i('b')], (x) => x.id)
    expect(atual).toHaveLength(1)
  })

  it('duplicata dentro da própria página também cai', () => {
    const r = mesclarPagina([], [i('a'), i('a')], (x) => x.id)
    expect(r).toHaveLength(1)
  })
})

describe('queryDeLista', () => {
  it('omite vazios e nulos; codifica o cursor', () => {
    expect(queryDeLista({ cursor: 'a§b==', busca: '', estado: null, x: undefined })).toBe('?cursor=a%C2%A7b%3D%3D')
    expect(queryDeLista({})).toBe('')
    expect(queryDeLista({ pagina: 0 })).toBe('?pagina=0')
  })
})
