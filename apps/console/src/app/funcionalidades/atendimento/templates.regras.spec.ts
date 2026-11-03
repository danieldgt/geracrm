import { describe, expect, it } from 'vitest'
import { mapeamentoParaSalvar, variaveisDoTemplate, variaveisSemCampo } from './templates.regras.js'

describe('variaveisDoTemplate', () => {
  it('detecta {{n}} no cabeçalho e no corpo, únicas e ordenadas', () => {
    expect(variaveisDoTemplate({ header: { texto: 'Oi {{2}}' }, body: { texto: 'Olá {{1}}, {{2}} de novo' } })).toEqual([1, 2])
  })
  it('sem corpo ou sem variável devolve vazio', () => {
    expect(variaveisDoTemplate(null)).toEqual([])
    expect(variaveisDoTemplate({ body: { texto: 'Sem variáveis' } })).toEqual([])
  })
})

describe('mapeamentoParaSalvar', () => {
  it('ignora escolha vazia e variável que não existe mais', () => {
    expect(mapeamentoParaSalvar([1, 2], { '1': 'contato.nome', '2': '', '9': 'contato.email' })).toEqual({ '1': 'contato.nome' })
  })
})

describe('variaveisSemCampo', () => {
  it('conta as variáveis sem campo', () => {
    expect(variaveisSemCampo([1, 2, 3], { '1': 'contato.nome' })).toBe(2)
    expect(variaveisSemCampo([], {})).toBe(0)
  })
})
