import { describe, it, expect } from 'vitest'
import { paraCsv } from '../../compartilhado/ui/csv.js'
import { DIMENSOES_RELATORIO, configDaDimensao } from './relatorio-dimensao.config.js'
import {
  LARGURA_MINIMA, escalarBarras, formatarTaxa, linhasCsv, queryDoPeriodo, resumoDoRelatorio, type ItemRelatorio,
} from './relatorio-dimensao.regras.js'

const item = (chave: string, contatos: number, convertidos: number, valorCentavos: number): ItemRelatorio => ({
  chave, rotulo: `Grupo ${chave}`, contatos, convertidos,
  taxa: contatos > 0 ? Math.round((convertidos / contatos) * 10_000) / 10_000 : null, valorCentavos,
})

describe('escalarBarras', () => {
  it('o maior ocupa 100% e os demais são proporcionais', () => {
    const r = escalarBarras([{ chave: 'a', rotulo: 'A', valor: 10 }, { chave: 'b', rotulo: 'B', valor: 5 }])
    expect(r.map((b) => b.largura)).toEqual([100, 50])
  })
  it('zero fica sem barra e valor pequeno tem largura mínima', () => {
    const r = escalarBarras([{ chave: 'a', rotulo: 'A', valor: 1000 }, { chave: 'b', rotulo: 'B', valor: 1 }, { chave: 'c', rotulo: 'C', valor: 0 }])
    expect(r[1]?.largura).toBe(LARGURA_MINIMA)
    expect(r[2]?.largura).toBe(0)
  })
  it('sem valores positivos, tudo em zero (sem divisão por zero)', () => {
    expect(escalarBarras([{ chave: 'a', rotulo: 'A', valor: 0 }]).map((b) => b.largura)).toEqual([0])
    expect(escalarBarras([])).toEqual([])
  })
  it('preserva o rótulo (ele sempre vai ao lado da barra)', () => {
    expect(escalarBarras([{ chave: 'a', rotulo: 'Instagram', valor: 3 }])[0]?.rotulo).toBe('Instagram')
  })
})

describe('queryDoPeriodo', () => {
  it('monta a query com as duas pontas', () => {
    expect(queryDoPeriodo('2026-09-01', '2026-09-30')).toBe('inicio=2026-09-01&fim=2026-09-30')
  })
  it('vazia quando falta uma ponta (a API assume o mês atual)', () => {
    expect(queryDoPeriodo('', '2026-09-30')).toBe('')
    expect(queryDoPeriodo('2026-09-01', '')).toBe('')
    expect(queryDoPeriodo('', '')).toBe('')
  })
})

describe('resumo e taxa', () => {
  it('a taxa é do conjunto, não a média das taxas', () => {
    const r = resumoDoRelatorio([item('a', 1, 1, 1000), item('b', 9, 0, 0)])
    expect(r).toEqual({ contatos: 10, convertidos: 1, taxa: 0.1, valorCentavos: 1000 })
  })
  it('sem contatos, taxa nula e formatada como traço', () => {
    expect(resumoDoRelatorio([]).taxa).toBeNull()
    expect(formatarTaxa(null)).toBe('—')
  })
  it('formata em porcentagem pt-BR', () => {
    expect(formatarTaxa(0.5)).toBe('50%')
    expect(formatarTaxa(0.1234)).toBe('12,3%')
  })
})

describe('linhasCsv', () => {
  it('taxa em % e valor em reais, com cabeçalho da dimensão', () => {
    const { colunas, linhas } = linhasCsv([item('a', 3, 1, 25050)], 'Origem')
    expect(colunas[0]?.rotulo).toBe('Origem')
    expect(linhas[0]).toEqual({ rotulo: 'Grupo a', contatos: 3, convertidos: 1, taxa: 33.33, valor: 250.5 })
  })
  it('grupo sem taxa vira célula vazia e o CSV sai com vírgula decimal', () => {
    const { colunas, linhas } = linhasCsv([item('a', 0, 0, 0), item('b', 3, 1, 25050)])
    expect(linhas[0]?.['taxa']).toBeNull()
    const texto = paraCsv(colunas, linhas)
    expect(texto).toContain('Grupo;Contatos;Convertidos;Conversão (%);Valor (R$)')
    expect(texto).toContain('Grupo a;0;0;;0')
    expect(texto).toContain('Grupo b;3;1;33,33;250,5')
  })
  it('neutraliza fórmula no rótulo (CSV injection)', () => {
    const { colunas, linhas } = linhasCsv([{ ...item('a', 1, 0, 0), rotulo: '=SOMA(A1)' }])
    expect(paraCsv(colunas, linhas)).toContain("'=SOMA(A1)")
  })
})

describe('config das dimensões', () => {
  it('as seis dimensões da API, com chave única e aba', () => {
    expect(DIMENSOES_RELATORIO.map((d) => d.chave)).toEqual(['origem', 'etapa', 'vendedor', 'dia-semana', 'qualificacao', 'uf'])
    expect(new Set(DIMENSOES_RELATORIO.map((d) => d.chave)).size).toBe(6)
    expect(configDaDimensao('uf').colunaRotulo).toBe('UF')
  })
})
