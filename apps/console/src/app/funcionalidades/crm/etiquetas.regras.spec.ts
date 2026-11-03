import { describe, it, expect } from 'vitest'
import { diferencaSelecao, erroDoNome, lerOrdem, tokenDaCor, ehCorEtiqueta, CORES_ETIQUETA } from './etiquetas.regras.js'

describe('diferencaSelecao', () => {
  it('sem mudança, mesmo em outra ordem ou com repetição', () => {
    expect(diferencaSelecao(['b', 'a', 'a'], ['a', 'b']).mudou).toBe(false)
    expect(diferencaSelecao([], []).mudou).toBe(false)
  })
  it('separa adicionadas e removidas', () => {
    expect(diferencaSelecao(['a', 'c'], ['a', 'b'])).toEqual({ adicionadas: ['c'], removidas: ['b'], mudou: true })
  })
  it('limpar tudo conta como mudança', () => {
    expect(diferencaSelecao([], ['a'])).toEqual({ adicionadas: [], removidas: ['a'], mudou: true })
  })
})

describe('cor', () => {
  it('toda cor da paleta vira token; neutro e desconhecida caem no tom suave', () => {
    for (const c of CORES_ETIQUETA) expect(ehCorEtiqueta(c)).toBe(true)
    expect(tokenDaCor('sucesso')).toBe('var(--sucesso)')
    expect(tokenDaCor('neutro')).toBe('var(--texto-suave)')
    expect(tokenDaCor('desconhecida')).toBe('var(--texto-suave)')
  })
})

describe('formulário', () => {
  it('nome: obrigatório e com teto', () => {
    expect(erroDoNome('  ', 40)).not.toBeNull()
    expect(erroDoNome('x'.repeat(41), 40)).not.toBeNull()
    expect(erroDoNome(' VIP ', 40)).toBeNull()
  })
  it('ordem: vazio vale 0; só inteiros de até 4 dígitos', () => {
    expect(lerOrdem('')).toBe(0)
    expect(lerOrdem(' 12 ')).toBe(12)
    expect(lerOrdem('-1')).toBeNull()
    expect(lerOrdem('1.5')).toBeNull()
    expect(lerOrdem('10000')).toBeNull()
  })
})
