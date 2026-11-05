import { describe, it, expect } from 'vitest'
import { AGENTE_VAZIO, blocoDoAgente, resumoFaixas, temNpsNoPeriodo, textoScore } from './nps.regras.js'

/** Painel de NPS: a nota do agente (G3) num bloco próprio. */
describe('NPS — bloco do agente', () => {
  const ag = { total: 2, promotores: 1, neutros: 0, detratores: 1, score: 0 }
  it('API sem o bloco = agente zerado (não quebra)', () => {
    expect(blocoDoAgente({})).toEqual(AGENTE_VAZIO)
    expect(blocoDoAgente({ agente: ag })).toEqual(ag)
  })
  it('há dados no período com vendedor OU só com nota do agente', () => {
    expect(temNpsNoPeriodo({ porAtendente: [], agente: ag })).toBe(true)
    expect(temNpsNoPeriodo({ porAtendente: [{}] })).toBe(true)
    expect(temNpsNoPeriodo({ porAtendente: [], agente: AGENTE_VAZIO })).toBe(false)
  })
  it('score com sinal e faixas', () => {
    expect([textoScore(40), textoScore(0), textoScore(-20), textoScore(null)]).toEqual(['+40', '0', '−20', '—'])
    expect(resumoFaixas(ag)).toBe('1 prom · 0 neu · 1 det')
  })
})
