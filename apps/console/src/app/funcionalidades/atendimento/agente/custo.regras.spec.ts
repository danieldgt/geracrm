import { describe, it, expect } from 'vitest'
import { escolhaDoTeto, orcamentoParaSalvar, percentualDoMes, tetoParaSalvar } from './custo.regras.js'

describe('Teto por conversa: escolha ↔ corpo', () => {
  it('null = padrão; 0 = sem teto; valor = personalizado', () => {
    expect(escolhaDoTeto(null)).toBe('padrao')
    expect(escolhaDoTeto(0)).toBe('sem_teto')
    expect(escolhaDoTeto(250)).toBe('personalizado')
  })

  it('personalizado converte reais em centavos inteiros e recusa zero ou texto inválido', () => {
    expect(tetoParaSalvar('personalizado', '2,50')).toEqual({ ok: true, tetoSessaoCentavos: 250 })
    expect(tetoParaSalvar('personalizado', 'R$ 1.234,56')).toEqual({ ok: true, tetoSessaoCentavos: 123456 })
    expect(tetoParaSalvar('personalizado', '0').ok).toBe(false)
    expect(tetoParaSalvar('personalizado', 'abc').ok).toBe(false)
    expect(tetoParaSalvar('personalizado', '').ok).toBe(false)
  })

  it('padrão e sem teto ignoram o texto', () => {
    expect(tetoParaSalvar('padrao', 'lixo')).toEqual({ ok: true, tetoSessaoCentavos: null })
    expect(tetoParaSalvar('sem_teto', 'lixo')).toEqual({ ok: true, tetoSessaoCentavos: 0 })
  })
})

describe('Orçamento mensal', () => {
  it('vazio remove o orçamento; valor vira centavos; zero é recusado', () => {
    expect(orcamentoParaSalvar('  ')).toEqual({ ok: true, mensalCentavos: null })
    expect(orcamentoParaSalvar('500')).toEqual({ ok: true, mensalCentavos: 50000 })
    expect(orcamentoParaSalvar('0,00').ok).toBe(false)
  })

  it('percentual inteiro; a barra para em 100, o texto mostra o real', () => {
    expect(percentualDoMes(850, 1000)).toEqual({ real: 85, barra: 85 })
    expect(percentualDoMes(2500, 1000)).toEqual({ real: 250, barra: 100 })
    expect(percentualDoMes(10, null)).toBeNull()
  })
})
