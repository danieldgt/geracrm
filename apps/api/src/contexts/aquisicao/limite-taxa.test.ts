import { describe, it, expect } from 'vitest'
import { criarLimiteTaxa } from './limite-taxa.js'

/** O relógio entra por parâmetro — teste de tempo não pode depender de espera. */
describe('Limite de taxa da superfície pública', () => {
  it('deixa passar até o teto e barra o excedente', () => {
    const l = criarLimiteTaxa({ teto: 3, janelaMs: 60_000 })
    const t = 1_000_000

    expect(l.permitir('ip1', t)).toBe(true)
    expect(l.permitir('ip1', t)).toBe(true)
    expect(l.permitir('ip1', t)).toBe(true)
    expect(l.permitir('ip1', t)).toBe(false)
  })

  it('a janela seguinte começa limpa', () => {
    const l = criarLimiteTaxa({ teto: 1, janelaMs: 60_000 })
    expect(l.permitir('ip1', 1_000_000)).toBe(true)
    expect(l.permitir('ip1', 1_000_000)).toBe(false)
    expect(l.permitir('ip1', 1_000_000 + 60_000)).toBe(true)
  })

  it('chaves diferentes não disputam a mesma cota', () => {
    const l = criarLimiteTaxa({ teto: 1, janelaMs: 60_000 })
    expect(l.permitir('ip1', 0)).toBe(true)
    expect(l.permitir('ip2', 0)).toBe(true)
  })

  /**
   * ⚠️ Sem teto de chaves o limitador VIRA o vazamento: cada IP novo cria uma
   * entrada, e um scanner cria milhões. A poda é no caminho de escrita, não em
   * temporizador — `setInterval` de limpeza sobrevive ao processo de teste e
   * segura o encerramento.
   */
  it('mapa cheio descarta a entrada mais antiga em vez de crescer sem fim', () => {
    const l = criarLimiteTaxa({ teto: 5, janelaMs: 1_000, maxChaves: 3 })
    l.permitir('a', 0); l.permitir('b', 0); l.permitir('c', 0)
    expect(l.tamanho()).toBe(3)
    expect(l.permitir('d', 5_000)).toBe(true)
    expect(l.tamanho()).toBe(3)
  })

  /**
   * ⚠️ Antes, mapa cheio na mesma janela RECUSAVA: um scanner com milhares de IPs enchia o mapa e
   * bloqueava todo visitante legítimo. Agora o mais antigo sai e o legítimo passa.
   */
  it('mapa cheio não bloqueia o legítimo: o mais antigo é descartado (LRU)', () => {
    const l = criarLimiteTaxa({ teto: 1, janelaMs: 60_000, maxChaves: 2 })
    expect(l.permitir('a', 0)).toBe(true)
    expect(l.permitir('b', 0)).toBe(true)
    expect(l.permitir('legitimo', 0)).toBe(true)
    expect(l.tamanho()).toBe(2)
    // 'b' foi usado depois de 'a': 'a' foi quem saiu, 'b' continua contado.
    expect(l.permitir('b', 0)).toBe(false)
  })

  it('uso recente protege a chave do descarte', () => {
    const l = criarLimiteTaxa({ teto: 1, janelaMs: 60_000, maxChaves: 2 })
    l.permitir('a', 0); l.permitir('b', 0)
    expect(l.permitir('a', 0)).toBe(false) // 'a' tocado agora
    l.permitir('c', 0) // descarta 'b'
    expect(l.permitir('a', 0)).toBe(false) // 'a' ainda contado
  })
})
