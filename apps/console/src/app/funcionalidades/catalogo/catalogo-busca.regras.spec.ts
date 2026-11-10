import { describe, it, expect } from 'vitest'
import { descreverBusca, motivoBuscaPorTrecho, usaBuscaInteligente } from './catalogo-busca.regras.js'

describe('usaBuscaInteligente', () => {
  it('só com texto, no modo inteligente e sem inativos', () => {
    expect(usaBuscaInteligente('inteligente', 'camiseta', false)).toBe(true)
    expect(usaBuscaInteligente('inteligente', '   ', false)).toBe(false)
    expect(usaBuscaInteligente('inteligente', 'camiseta', true)).toBe(false)
    expect(usaBuscaInteligente('trecho', 'camiseta', false)).toBe(false)
  })
})

describe('descreverBusca', () => {
  it('com as três pernas e sem corte: uma linha, nenhum aviso', () => {
    expect(descreverBusca({ fontes: ['lexical', 'trgm', 'semantica'], semantica: 'ligada', truncado: false }, 3)).toEqual({
      resumo: 'Busca inteligente: 3 produtos, do mais ao menos relevante, por palavras, grafia aproximada e significado.',
      avisos: [],
    })
  })

  it('singular, pernas fora de ordem saem na ordem fixa', () => {
    expect(descreverBusca({ fontes: ['trgm', 'lexical'], semantica: 'sem_chave', truncado: false }, 1).resumo)
      .toBe('Busca inteligente: 1 produto, do mais ao menos relevante, por palavras e grafia aproximada.')
  })

  it('cortou: pede para refinar; semântica desligada: diz por quê e o que falta', () => {
    const d = descreverBusca({ fontes: ['lexical'], semantica: 'sem_indice', truncado: true }, 30)
    expect(d.avisos).toEqual([
      'Mostrando os 30 mais próximos. Refine a busca para ver outros.',
      'A busca por significado está desligada: o banco não tem o índice vetorial (pgvector).',
    ])
  })

  it('cada situação da semântica tem a sua frase', () => {
    const frase = (semantica: 'sem_chave' | 'indisponivel') => descreverBusca({ fontes: ['lexical'], semantica, truncado: false }, 2).avisos[0]
    expect(frase('sem_chave')).toMatch(/provedor de embedding/)
    expect(frase('indisponivel')).toMatch(/não respondeu agora/)
  })
})

describe('motivoBuscaPorTrecho', () => {
  it('explica a troca só quando "Mostrar inativos" desliga a inteligente', () => {
    expect(motivoBuscaPorTrecho('inteligente', 'camiseta', true)).toMatch(/Mostrar inativos/)
    expect(motivoBuscaPorTrecho('inteligente', 'camiseta', false)).toBeNull()
    expect(motivoBuscaPorTrecho('trecho', 'camiseta', true)).toBeNull()
    expect(motivoBuscaPorTrecho('inteligente', '', true)).toBeNull()
  })
})
