import { describe, it, expect } from 'vitest'
import { classificarRfv } from './rfv.js'

/**
 * ⚠️ O que se testa aqui é a REGRA de negócio — onde cada cliente cai no ciclo
 * de recompra. Um segmento errado manda a vendedora falar com quem não precisa
 * e ignorar quem está indo embora.
 */
describe('classificarRfv', () => {
  it('⚠️ sem ritmo (1 compra) NÃO inventa atraso — classifica por recência', () => {
    const recente = classificarRfv({ qtdVendas: 1, diasSemComprar: 10, atrasoRelativo: null })
    expect(recente.codigo).toBe('cliente-recente')

    const parado = classificarRfv({ qtdVendas: 1, diasSemComprar: 200, atrasoRelativo: null })
    // Inventar "atraso" sobre quem tem 1 compra produziria urgência fictícia.
    expect(parado.codigo).toBe('em-risco')
  })

  it('comprou dentro do ritmo → fiel, urgência baixa', () => {
    const s = classificarRfv({ qtdVendas: 8, diasSemComprar: 20, atrasoRelativo: 0.6 })
    expect(s.codigo).toBe('cliente-fiel')
    expect(s.urgencia).toBeLessThan(20)
  })

  it('⚠️ no ritmo dele chegou a hora → nao-perder (o momento de agir)', () => {
    // atraso ~1 = exatamente o intervalo típico dele. É quando a conversa
    // converte — nem cedo demais (irrita) nem tarde demais (perdeu).
    const s = classificarRfv({ qtdVendas: 5, diasSemComprar: 42, atrasoRelativo: 1.05 })
    expect(s.codigo).toBe('nao-perder')
  })

  it('passou do ritmo → em-risco, urgência alta', () => {
    const s = classificarRfv({ qtdVendas: 5, diasSemComprar: 90, atrasoRelativo: 2.0 })
    expect(s.codigo).toBe('em-risco')
    expect(s.urgencia).toBeGreaterThan(60)
  })

  it('muito além do ritmo → hibernando', () => {
    const s = classificarRfv({ qtdVendas: 4, diasSemComprar: 400, atrasoRelativo: 8 })
    expect(s.codigo).toBe('hibernando')
  })

  it('⚠️ a urgência ORDENA a fila: atrasado age antes de fiel', () => {
    const fiel = classificarRfv({ qtdVendas: 10, diasSemComprar: 15, atrasoRelativo: 0.5 })
    const atrasado = classificarRfv({ qtdVendas: 6, diasSemComprar: 120, atrasoRelativo: 2.2 })
    // Quem está indo embora precisa aparecer no topo do dia, não o fiel em dia.
    expect(atrasado.urgencia).toBeGreaterThan(fiel.urgencia)
  })

  it('todo segmento tem rótulo e ação — "em risco" sem ação é rótulo bonito e inútil', () => {
    for (const a of [null, 0.5, 1.1, 2.0, 3.5, 9]) {
      const s = classificarRfv({ qtdVendas: 3, diasSemComprar: 100, atrasoRelativo: a })
      expect(s.rotulo.length).toBeGreaterThan(2)
      expect(s.acao.length).toBeGreaterThan(5)
    }
  })
})
