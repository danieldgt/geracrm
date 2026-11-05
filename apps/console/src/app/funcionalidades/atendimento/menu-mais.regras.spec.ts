import { describe, it, expect } from 'vitest'
import { ordenarItensMenu, proximoItemMenu, type ItemMenuMais } from './menu-mais.regras.js'

const itens: ItemMenuMais[] = [
  { id: 'a', rotulo: 'A' }, { id: 'b', rotulo: 'B', desabilitado: true }, { id: 'c', rotulo: 'C' },
]

describe('menu ⋯ — teclado', () => {
  it('seta para baixo pula o desabilitado e dá a volta', () => {
    expect(proximoItemMenu(itens, -1, 'ArrowDown')).toBe(0)
    expect(proximoItemMenu(itens, 0, 'ArrowDown')).toBe(2)
    expect(proximoItemMenu(itens, 2, 'ArrowDown')).toBe(0)
  })
  it('seta para cima dá a volta; Home e End vão às pontas', () => {
    expect(proximoItemMenu(itens, 0, 'ArrowUp')).toBe(2)
    expect(proximoItemMenu(itens, -1, 'ArrowUp')).toBe(2)
    expect(proximoItemMenu(itens, 2, 'Home')).toBe(0)
    expect(proximoItemMenu(itens, 0, 'End')).toBe(2)
  })
  it('outra tecla ou nada habilitado → null', () => {
    expect(proximoItemMenu(itens, 0, 'a')).toBeNull()
    expect(proximoItemMenu([{ id: 'x', rotulo: 'X', desabilitado: true }], -1, 'ArrowDown')).toBeNull()
  })
})

describe('menu ⋯ — destrutivo por último', () => {
  it('perigo vai para o fim, o resto mantém a ordem', () => {
    const r = ordenarItensMenu([{ id: 'd', rotulo: 'D', perigo: true }, { id: 'a', rotulo: 'A' }, { id: 'b', rotulo: 'B' }])
    expect(r.map((i) => i.id)).toEqual(['a', 'b', 'd'])
  })
})
