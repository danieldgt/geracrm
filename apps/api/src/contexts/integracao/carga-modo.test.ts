import { describe, it, expect } from 'vitest'
import { decidirCarga, podeMarcarConcluida, type EntradaDecisao } from './carga-modo.js'

/**
 * ⚠️ O que esta regra protege é o ERP DO CLIENTE. O integrador roda de 6 em 6
 * horas e a ingestão pede a base `desde` uma data — sem a separação entre
 * histórico e incremental, tirar o teto de páginas viraria quatro varreduras
 * completas por dia no sistema de onde ele fatura.
 */
const AGORA = new Date('2026-08-25T12:00:00Z')
const base: EntradaDecisao = {
  temRecibo: false,
  desdeHistorico: new Date('2024-01-01T00:00:00Z'),
  diasIncremental: 7,
  maxPaginasEnv: 0,
  forcarHistorico: false,
  agora: AGORA,
}

describe('Primeira carga', () => {
  it('sem recibo, puxa o histórico inteiro e sem teto', () => {
    const d = decidirCarga(base)
    expect(d.modo).toBe('historico')
    expect(d.desde.toISOString().slice(0, 10)).toBe('2024-01-01')
    expect(d.maxPaginas).toBeUndefined()
  })

  it('e só ela pode virar recibo', () => {
    expect(podeMarcarConcluida(decidirCarga(base))).toBe(true)
  })
})

describe('Ciclos seguintes', () => {
  it('com recibo, olha só a janela recente', () => {
    const d = decidirCarga({ ...base, temRecibo: true })
    expect(d.modo).toBe('incremental')
    expect(d.desde.toISOString().slice(0, 10)).toBe('2026-08-18') // 7 dias atrás
  })

  /** Sobreposição é de propósito: a ingestão é idempotente por id externo, e
   *  perder uma venda na fronteira custa mais caro do que reprocessar algumas. */
  it('a janela é configurável', () => {
    const d = decidirCarga({ ...base, temRecibo: true, diasIncremental: 30 })
    expect(d.desde.toISOString().slice(0, 10)).toBe('2026-07-26')
  })

  it('ciclo incremental NUNCA vira recibo', () => {
    expect(podeMarcarConcluida(decidirCarga({ ...base, temRecibo: true }))).toBe(false)
  })
})

describe('⚠️ Carga truncada não pode se declarar completa', () => {
  /**
   * O pior resultado possível: o produto passa a operar incremental sobre um
   * histórico pela metade, e o RFV mente em silêncio — sem erro em lugar nenhum.
   */
  it('histórico COM teto de páginas é amostra, e não vira recibo', () => {
    const d = decidirCarga({ ...base, maxPaginasEnv: 5 })
    expect(d.modo).toBe('historico')
    expect(d.maxPaginas).toBe(5)
    expect(podeMarcarConcluida(d)).toBe(false)
  })
})

describe('Refazer à mão', () => {
  it('FORCAR_HISTORICO ignora o recibo e explica o porquê no motivo', () => {
    const d = decidirCarga({ ...base, temRecibo: true, forcarHistorico: true })
    expect(d.modo).toBe('historico')
    expect(d.motivo).toContain('FORCAR_HISTORICO')
  })
})
