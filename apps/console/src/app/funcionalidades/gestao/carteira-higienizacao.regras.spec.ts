import { describe, it, expect } from 'vitest'
import { montarIndicador } from '@geracrm/shared'
import { paramsDaApi } from '../crm/clientes.regras.js'
import {
  RECORTE_VAZIO, estadoDoIndicador, filtrosDaLista, grupoSelecionado, larguraDaBarra, linhasDosGruposCarteira, queryDoIndicador,
  recorteAtivo, recorteDaQuery, recorteDoGrupo, textoDaMeta,
} from './carteira-higienizacao.regras.js'

const UUID = '0190a000-0000-7000-8000-000000000001'

describe('indicador contra a meta', () => {
  it('estado: atingida, atenção e crítica', () => {
    expect(estadoDoIndicador(montarIndicador(100, 95))).toBe('atingida')
    expect(estadoDoIndicador(montarIndicador(100, 85))).toBe('atencao')
    expect(estadoDoIndicador(montarIndicador(100, 20))).toBe('critica')
  })
  it('a barra nunca sai de 0–100', () => {
    expect(larguraDaBarra(-5)).toBe(0)
    expect(larguraDaBarra(140)).toBe(100)
    expect(larguraDaBarra(Number.NaN)).toBe(0)
    expect(larguraDaBarra(42.5)).toBe(42.5)
  })
  it('texto da meta: falta, atingida e sem ativos', () => {
    expect(textoDaMeta(montarIndicador(100, 90))).toBe('Faltam 5 contatos com próximo passo para chegar a 95%.')
    expect(textoDaMeta(montarIndicador(20, 18))).toBe('Faltam 1 contato com próximo passo para chegar a 95%.')
    expect(textoDaMeta(montarIndicador(100, 99))).toBe('Meta de 95% atingida.')
    expect(textoDaMeta(montarIndicador(0, 0))).toContain('Nenhum contato ativo')
  })
})

describe('filtros da lista e do indicador', () => {
  it('a lista é sempre carteira ativa sem próximo passo, mais o recorte', () => {
    expect(paramsDaApi(filtrosDaLista(RECORTE_VAZIO), null)).toBe('limite=30&semProximoPasso=true&carteiraAtiva=true')
    expect(paramsDaApi(filtrosDaLista({ vendedorId: UUID, filialId: '' }), null)).toContain(`vendedorId=${UUID}`)
  })
  it('a query do indicador leva só filial e vendedor', () => {
    expect(queryDoIndicador(RECORTE_VAZIO)).toBe('')
    expect(queryDoIndicador({ vendedorId: UUID, filialId: '' }, 'filial')).toBe(`agrupar=filial&vendedorId=${UUID}`)
  })
  it('clicar num grupo: vendedor sem dono vira sem-dono; filial sem filial não filtra', () => {
    expect(recorteDoGrupo('vendedor', 'sem')).toEqual({ vendedorId: 'sem-dono', filialId: '' })
    expect(recorteDoGrupo('vendedor', UUID)).toEqual({ vendedorId: UUID, filialId: '' })
    expect(recorteDoGrupo('filial', UUID)).toEqual({ vendedorId: '', filialId: UUID })
    expect(recorteDoGrupo('filial', 'sem')).toBeNull()
  })
  it('grupo selecionado e recorte ativo', () => {
    const r = { vendedorId: UUID, filialId: '' }
    expect(grupoSelecionado('vendedor', UUID, r)).toBe(true)
    expect(grupoSelecionado('vendedor', 'sem', r)).toBe(false)
    expect(grupoSelecionado('filial', 'sem', RECORTE_VAZIO)).toBe(false)
    expect(recorteAtivo(r)).toBe(true)
    expect(recorteAtivo(RECORTE_VAZIO)).toBe(false)
  })
  it('recorte da URL descarta o que a API recusaria', () => {
    expect(recorteDaQuery({ vendedorId: 'lixo', filialId: UUID })).toEqual({ vendedorId: '', filialId: UUID })
    expect(recorteDaQuery({ vendedorId: 'sem-dono' })).toEqual({ vendedorId: 'sem-dono', filialId: '' })
  })
  it('linhas por grupo carregam o estado contra a meta', () => {
    const [l] = linhasDosGruposCarteira([{ chave: UUID, rotulo: 'Vera', ...montarIndicador(10, 2) }])
    expect(l).toMatchObject({ rotulo: 'Vera', percentual: 20, semProximoPasso: 8, estado: 'critica' })
  })
})
