import { describe, it, expect } from 'vitest'
import { montarEtapas, maiorPerdaRelativa, taxa } from './funil.js'

/**
 * Funil por origem (AQ-39).
 *
 * ⚠️ A regra pura é o coração do relatório: é ela que responde "em qual etapa o
 * dinheiro está parando". As consultas são exercitadas pelo teste de rota; aqui
 * ficam as decisões que mudariam a leitura de quem opera.
 */
const numeros = {
  impressoes: 10_000, cliques: 200, leads: 40, qualificados: 20, pedidos: 4, vendas: 2,
}
const CUSTO = 100_000 // R$ 1.000,00

describe('Custo por etapa', () => {
  it('divide o custo do período pela quantidade de cada degrau', () => {
    const e = montarEtapas(numeros, CUSTO)
    const porLead = e.find((x) => x.etapa === 'lead')!
    expect(porLead.custoUnitarioCentavos).toBe(2500)   // R$ 25,00 por lead
    const porVenda = e.find((x) => x.etapa === 'venda')!
    expect(porVenda.custoUnitarioCentavos).toBe(50_000) // R$ 500,00 por venda
  })

  /**
   * ⚠️ Etapa zerada tem custo INDEFINIDO, não zero. Exibir R$ 0,00 faria a etapa
   * que não converteu ninguém parecer a mais barata de todas — exatamente a
   * leitura invertida.
   */
  it('etapa zerada devolve null, nunca zero', () => {
    const e = montarEtapas({ ...numeros, vendas: 0 }, CUSTO)
    expect(e.find((x) => x.etapa === 'venda')!.custoUnitarioCentavos).toBeNull()
  })
})

describe('Fato × modelo', () => {
  /**
   * ⚠️ As três primeiras etapas são medidas; as três últimas dependem do modelo
   * de atribuição. Misturar sem dizer qual é qual empresta ao segundo a
   * credibilidade do primeiro (AMK-009).
   */
  it('marca quais degraus são fato e quais dependem do modelo', () => {
    const e = montarEtapas(numeros, CUSTO)
    expect(e.filter((x) => x.fato).map((x) => x.etapa)).toEqual(['impressao', 'clique', 'lead'])
    expect(e.filter((x) => !x.fato).map((x) => x.etapa)).toEqual(['qualificado', 'pedido', 'venda'])
  })
})

describe('Taxa entre degraus', () => {
  it('a primeira etapa não tem taxa — não há degrau acima', () => {
    expect(montarEtapas(numeros, CUSTO)[0]!.taxaDaAnterior).toBeNull()
  })

  it('calcula a conversão vinda do degrau anterior', () => {
    const e = montarEtapas(numeros, CUSTO)
    expect(e.find((x) => x.etapa === 'clique')!.taxaDaAnterior).toBeCloseTo(0.02)
    expect(e.find((x) => x.etapa === 'lead')!.taxaDaAnterior).toBeCloseTo(0.2)
  })

  it('degrau anterior zerado não vira divisão por zero', () => {
    expect(taxa(0, 5)).toBeNull()
  })
})

describe('⚠️ A maior perda é RELATIVA, não absoluta', () => {
  /**
   * De 10.000 impressões para 200 cliques perdem-se 9.800 pessoas — e isso é um
   * funil NORMAL. De 20 qualificados para 4 pedidos perdem-se 16, e é ali que
   * está o problema. Ordenar por perda absoluta apontaria sempre para o topo e
   * nunca diria nada útil.
   */
  it('aponta o degrau com a pior taxa, não o com mais gente perdida', () => {
    const pior = maiorPerdaRelativa(montarEtapas(numeros, CUSTO))
    expect(pior).toMatchObject({ de: 'Impressões', para: 'Cliques' })
    expect(pior!.taxa).toBeCloseTo(0.02)
  })

  it('com o topo saudável, aponta o gargalo de baixo', () => {
    // CTR alto (10%), lead alto, mas qualificado → pedido despenca.
    const pior = maiorPerdaRelativa(montarEtapas({
      impressoes: 1000, cliques: 100, leads: 80, qualificados: 60, pedidos: 1, vendas: 1,
    }, CUSTO))
    expect(pior).toMatchObject({ de: 'Qualificados', para: 'Pedidos' })
  })

  it('funil vazio não inventa gargalo', () => {
    const pior = maiorPerdaRelativa(montarEtapas({
      impressoes: 0, cliques: 0, leads: 0, qualificados: 0, pedidos: 0, vendas: 0,
    }, 0))
    expect(pior).toBeNull()
  })
})
