import { describe, it, expect } from 'vitest'
import {
  FILTROS_VAZIOS, PAGINA_PANORAMA, cartoesVisiveis, contarFiltros, filtrosDoGrupo, lerQueryParams, montarCartoes,
  paraQueryParams, queryDaApi, type GrupoPanorama,
} from './funil-filtros.regras.js'

describe('filtros <-> query params', () => {
  it('URL vazia = panorama por filial, sem filtros', () => {
    expect(lerQueryParams({})).toEqual({ visao: 'panorama', agrupar: 'filial', filtros: FILTROS_VAZIOS })
  })

  it('lê visão, agrupamento e filtros; valor desconhecido cai no padrão', () => {
    const e = lerQueryParams({ visao: 'board', agrupar: 'vendedor', q: ' mercado ', vendedorId: 'u1', filialId: 'f1', etiquetaId: 'e1', origemId: 'o1' })
    expect(e.visao).toBe('board')
    expect(e.agrupar).toBe('vendedor')
    expect(e.filtros).toEqual({ busca: 'mercado', vendedorId: 'u1', filialId: 'f1', etiquetaId: 'e1', origemId: 'o1' })
    expect(lerQueryParams({ visao: 'x', agrupar: 'y' })).toMatchObject({ visao: 'panorama', agrupar: 'filial' })
  })

  it('ida e volta preserva o estado', () => {
    const e = lerQueryParams({ visao: 'board', agrupar: 'vendedor', q: 'ana', etiquetaId: 'e1' })
    const params = paraQueryParams(e)
    const volta = lerQueryParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v !== null)) as Record<string, string>)
    expect(volta).toEqual(e)
  })

  it('o padrão e os filtros vazios saem da URL (null remove o param)', () => {
    expect(paraQueryParams(lerQueryParams({}))).toEqual({
      visao: null, agrupar: null, q: null, vendedorId: null, filialId: null, etiquetaId: null, origemId: null,
    })
  })

  it('query da API só leva filtros preenchidos e codifica o texto', () => {
    expect(queryDaApi(FILTROS_VAZIOS)).toBe('')
    expect(queryDaApi({ ...FILTROS_VAZIOS, busca: 'a&b c', vendedorId: 'sem-dono' })).toBe('?q=a%26b+c&vendedorId=sem-dono')
  })

  it('conta filtros ativos ignorando espaços', () => {
    expect(contarFiltros({ ...FILTROS_VAZIOS, busca: '  ', origemId: 'o1', filialId: 'f1' })).toBe(2)
  })
})

describe('clicar no cartão abre o board filtrado', () => {
  it('por vendedor e por filial; "sem dono" é sempre vendedor', () => {
    expect(filtrosDoGrupo('vendedor', 'u1')).toEqual({ ...FILTROS_VAZIOS, vendedorId: 'u1' })
    expect(filtrosDoGrupo('filial', 'f1')).toEqual({ ...FILTROS_VAZIOS, filialId: 'f1' })
    expect(filtrosDoGrupo('filial', 'sem-dono')).toEqual({ ...FILTROS_VAZIOS, vendedorId: 'sem-dono' })
    expect(filtrosDoGrupo('filial', 'sem-filial')).toEqual({ ...FILTROS_VAZIOS, filialId: 'sem-filial' })
  })
})

describe('cartões do panorama', () => {
  const etapas = [{ id: 'e1', nome: 'Lead' }, { id: 'e2', nome: 'Conversa' }]
  const grupo = (o: Partial<GrupoPanorama> = {}): GrupoPanorama => ({
    chave: 'g1', rotulo: 'Filial X', ativos: 5, ganhosMes: 2, perdidosMes: 1, semProximoPasso: 3,
    porEtapa: [{ etapaId: 'e2', total: 4 }, { etapaId: 'e1', total: 1 }], ...o,
  })

  it('selos com cor E rótulo; sem próximo passo em atenção só quando há', () => {
    const [c] = montarCartoes([grupo()], etapas)
    expect(c!.selos.map((s) => [s.id, s.valor, s.tom])).toEqual([
      ['ativos', 5, 'info'], ['ganhos', 2, 'sucesso'], ['semPasso', 3, 'atencao'], ['perdidos', 1, 'erro'],
    ])
    expect(c!.selos.find((s) => s.id === 'semPasso')!.rotulo).toBe('sem próximo passo')
    const [zero] = montarCartoes([grupo({ semProximoPasso: 0, ganhosMes: 0, perdidosMes: 0 })], etapas)
    expect(zero!.selos.filter((s) => s.id !== 'ativos').every((s) => s.tom === 'neutro')).toBe(true)
  })

  it('contagem por etapa segue a ordem do funil e zera a ausente', () => {
    const [c] = montarCartoes([grupo({ porEtapa: [{ etapaId: 'e2', total: 4 }] })], etapas)
    expect(c!.etapas).toEqual([
      { etapaId: 'e1', nome: 'Lead', total: 0 }, { etapaId: 'e2', nome: 'Conversa', total: 4 },
    ])
  })

  it('marca o grupo sem dono', () => {
    expect(montarCartoes([grupo({ chave: 'sem-dono', rotulo: 'Sem dono' })], etapas)[0]!.semDono).toBe(true)
  })

  it('carregar mais: mostra PAGINA_PANORAMA por vez', () => {
    const muitos = Array.from({ length: 130 }, (_, i) => i)
    const p1 = cartoesVisiveis(muitos, PAGINA_PANORAMA)
    expect(p1.itens).toHaveLength(60)
    expect(p1.temMais).toBe(true)
    const p3 = cartoesVisiveis(muitos, PAGINA_PANORAMA * 3)
    expect(p3.itens).toHaveLength(130)
    expect(p3.temMais).toBe(false)
    expect(cartoesVisiveis([], 60)).toEqual({ itens: [], temMais: false, restantes: 0 })
  })
})
