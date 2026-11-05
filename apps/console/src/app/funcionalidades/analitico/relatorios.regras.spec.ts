import { describe, it, expect } from 'vitest'
import {
  GRUPOS_RELATORIO, grupoDaFolha, paramsDaSelecao, selecaoDaSubAba, selecaoDaUrl, selecaoDoGrupo, subAbaAtiva, subAbas,
} from './relatorios.regras.js'

describe('relatórios — grupos e URL', () => {
  it('são no máximo 8 grupos e nenhuma folha se repete', () => {
    expect(GRUPOS_RELATORIO.length).toBeLessThanOrEqual(8)
    const folhas = GRUPOS_RELATORIO.flatMap((g) => g.folhas.map((f) => f.id))
    expect(new Set(folhas).size).toBe(folhas.length)
  })

  it('os destinos das rotas antigas abrem o relatório certo', () => {
    expect(grupoDaFolha(selecaoDaUrl('vendas', null).folha).id).toBe('vendas') // /bi
    expect(selecaoDaUrl('contatos', 'uf')).toEqual({ folha: 'contatos', dim: 'uf' }) // /mapa
    expect(grupoDaFolha(selecaoDaUrl('atendimento', null).folha).id).toBe('atendimento') // /performance, /nps
    expect(grupoDaFolha(selecaoDaUrl('enviadas', null).folha).id).toBe('whatsapp') // /mensagens
  })

  it('sem parâmetro ou com lixo cai na visão geral e na primeira dimensão', () => {
    expect(selecaoDaUrl(null, null)).toEqual({ folha: 'visao-geral', dim: 'origem' })
    expect(selecaoDaUrl('bi', 'xpto')).toEqual({ folha: 'visao-geral', dim: 'origem' })
  })

  it('a dimensão só vai para a URL nos contatos por dimensão', () => {
    expect(paramsDaSelecao({ folha: 'contatos', dim: 'uf' })).toEqual({ relatorio: 'contatos', dim: 'uf' })
    expect(paramsDaSelecao({ folha: 'vendas', dim: 'uf' })).toEqual({ relatorio: 'vendas', dim: null })
  })
})

describe('relatórios — sub-abas', () => {
  const contatos = GRUPOS_RELATORIO.find((g) => g.id === 'contatos')!

  it('grupo de uma folha não tem segunda fileira', () => {
    expect(subAbas(GRUPOS_RELATORIO.find((g) => g.id === 'atendimento')!)).toEqual([])
  })

  it('em Contatos, as dimensões viram abas na mesma fileira da lista e do cadastro', () => {
    const ids = subAbas(contatos).map((a) => a.id)
    expect(ids).toContain('dim:uf')
    expect(ids).toContain('lista')
    expect(ids).not.toContain('contatos')
  })

  it('clicar numa dimensão seleciona contatos com ela; clicar na lista mantém a dimensão guardada', () => {
    const s = selecaoDaSubAba('dim:uf', { folha: 'contatos', dim: 'origem' })
    expect(s).toEqual({ folha: 'contatos', dim: 'uf' })
    expect(subAbaAtiva(s)).toBe('dim:uf')
    expect(selecaoDaSubAba('lista', s)).toEqual({ folha: 'lista', dim: 'uf' })
  })

  it('clicar num grupo abre a primeira folha dele', () => {
    expect(selecaoDoGrupo('whatsapp', { folha: 'vendas', dim: 'origem' }).folha).toBe('whatsapp')
  })
})
