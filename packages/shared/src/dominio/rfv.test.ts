import { describe, it, expect } from 'vitest'
import { classificarRfv, faixasDoSegmento, CODIGOS_SEGMENTO_RFV, ehCodigoSegmentoRfv, type FaixaRfv, type MetricasRfv } from './rfv.js'

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

describe('faixasDoSegmento — a faixa que a API usa no SQL concorda com classificarRfv', () => {
  const dentro = (f: FaixaRfv, m: MetricasRfv): boolean => {
    if (f.tipo === 'ritmo') {
      const a = m.atrasoRelativo
      return a !== null && (f.apos === null || a > f.apos) && (f.ate === null || a <= f.ate)
    }
    if (m.atrasoRelativo !== null) return false
    if (f.tipo === 'sem_ritmo_recente') return m.diasSemComprar !== null && m.diasSemComprar <= f.diasAte
    return m.diasSemComprar === null || m.diasSemComprar > f.diasApos
  }
  const atrasos = [null, 0, 0.5, 0.9, 0.91, 1.4, 1.41, 2.5, 2.51, 5, 5.01, 9]
  const dias = [null, 0, 30, 60, 61, 400]

  it('cada métrica cai em exatamente o segmento que classificarRfv devolve', () => {
    for (const a of atrasos) for (const d of dias) {
      const m = { qtdVendas: a === null ? 1 : 3, diasSemComprar: d, atrasoRelativo: a }
      const codigo = classificarRfv(m).codigo
      for (const c of CODIGOS_SEGMENTO_RFV) {
        const casa = faixasDoSegmento(c).some((f) => dentro(f, m))
        expect(casa, `${c} para atraso=${a} dias=${d}`).toBe(c === codigo)
      }
    }
  })

  it('ehCodigoSegmentoRfv rejeita o que não é código', () => {
    expect(ehCodigoSegmentoRfv('em-risco')).toBe(true)
    expect(ehCodigoSegmentoRfv('toString')).toBe(false)
    expect(ehCodigoSegmentoRfv(1)).toBe(false)
  })
})
