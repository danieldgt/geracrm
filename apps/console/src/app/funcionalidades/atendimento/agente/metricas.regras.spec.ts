import { describe, it, expect } from 'vitest'
import type { CriterioFase, GoLiveDto, MetricasAgenteDto } from '@geracrm/shared'
import {
  criteriosEmOrdem, indicadores, rotuloDoMotivo, situacaoDoCriterio, tempoNaFase, trilhaDeFases, vereditoDaFase,
} from './metricas.regras.js'

const c = (id: string, ok: boolean | null): CriterioFase =>
  ({ id, rotulo: id, alvo: 'x', valor: ok === null ? null : '1', ok, fonte: 'f', ...(ok === null ? { indisponivel: true as const, motivo: 'm' } : {}) })

const base: GoLiveDto = {
  canalId: 'c', fase: 'sombra', rotuloFase: 'Sombra', proximaFase: 'assistido', criterios: [], podeAvancar: false,
  recomendacao: 'manter', voltarPara: null, pendencias: { reprovados: [], indisponiveis: [] },
  dias: 16, diasUteis: 12, inicioFase: '2026-10-01T00:00:00Z', inicioEstimado: false, janelaDias: 16,
  modoAgora: { modo: 'sombra', origem: 'numero', motivo: null }, alvosProposta: true,
}

describe('Critérios no painel', () => {
  it('situação: true cumpre, false não cumpre, null sem medida', () => {
    expect(situacaoDoCriterio(c('a', true))).toBe('cumpre')
    expect(situacaoDoCriterio(c('a', false))).toBe('nao_cumpre')
    expect(situacaoDoCriterio(c('a', null))).toBe('indisponivel')
  })

  it('o que segura o avanço vem primeiro, estável dentro do grupo', () => {
    const r = criteriosEmOrdem([c('ok1', true), c('ind', null), c('no1', false), c('ok2', true), c('no2', false)])
    expect(r.map((x) => x.id)).toEqual(['no1', 'no2', 'ind', 'ok1', 'ok2'])
  })

  it('trilha marca feitas, atual e futuras', () => {
    expect(trilhaDeFases('assistido').map((p) => p.estado)).toEqual(['feita', 'feita', 'atual', 'futura', 'futura'])
  })
})

describe('Veredito do topo — só informa; aponta a Configuração para mudar o modo', () => {
  it('pode avançar → sucesso nomeando a próxima fase', () => {
    const v = vereditoDaFase({ ...base, podeAvancar: true, recomendacao: 'avancar' })
    expect(v).toMatchObject({ tom: 'sucesso', titulo: 'Pronto para Assistido' })
    expect(v.texto).toMatch(/Configuração/)
  })

  it('manter → conta reprovados e conferências à mão', () => {
    const v = vereditoDaFase({ ...base, pendencias: { reprovados: ['a', 'b'], indisponiveis: ['c'] } })
    expect(v.tom).toBe('neutro')
    expect(v.texto).toBe('2 critérios ainda não cumprem e 1 precisa de conferência à mão antes de Assistido.')
  })

  it('amplo violado → erro recomendando voltar', () => {
    const v = vereditoDaFase({ ...base, fase: 'autonomo_amplo', proximaFase: null, recomendacao: 'voltar', voltarPara: 'autonomo_recorte', janelaDias: 30, pendencias: { reprovados: ['opt_out'], indisponiveis: [] } })
    expect(v).toMatchObject({ tom: 'erro', titulo: 'Critério violado — recomenda voltar para Autônomo num recorte' })
  })

  it('amplo em dia → fase final', () => {
    expect(vereditoDaFase({ ...base, fase: 'autonomo_amplo', proximaFase: null, janelaDias: 30 }).titulo).toBe('Fase final')
  })

  it('tempo na fase diz quando o início é estimado', () => {
    expect(tempoNaFase(base)).toBe('há 16 dias (12 úteis)')
    expect(tempoNaFase({ ...base, inicioEstimado: true })).toMatch(/estimado/)
    expect(tempoNaFase({ ...base, inicioFase: null })).toMatch(/sem atividade/)
  })
})

describe('Indicadores de /v1/agente/metricas', () => {
  const m: MetricasAgenteDto = {
    dias: 7, canalId: 'c', turnos: 200, respondidos: 120, sugeridos: 40, handoffs: 30, falhas: 0, superadas: 2, conversas: 80,
    custoCentavos: 123456, custoPorConversaCentavos: 150, latenciaP95Ms: 4321, turnosComNumeroBloqueado: 3, taxaCache: 0.62,
    handoffPorMotivo: [], pedidos: { propostos: 10, confirmados: 7, efetivados: 5, valorEfetivadoCentavos: 1 }, conversasCorrigidasPorHumano: 4,
  }
  it('formata dinheiro, segundos e percentuais em pt-BR', () => {
    const i = Object.fromEntries(indicadores(m).map((x) => [x.rotulo, x]))
    expect(i['Custo por conversa']).toMatchObject({ valor: 'R$ 1,50', detalhe: 'total R$ 1.234,56' })
    expect(i['p95 de resposta']!.valor).toBe('4,3 s')
    expect(i['Passados para humano']!.detalhe).toBe('15% dos turnos')
    expect(i['Cache do prompt']!.valor).toBe('62%')
    expect(i['Pedidos']!.valor).toBe('10 → 7 → 5')
  })
  it('motivo de handoff legível; desconhecido fica cru', () => {
    expect(rotuloDoMotivo('opt_out')).toMatch(/não receber/)
    expect(rotuloDoMotivo('sem_motivo')).toBe('sem motivo registrado')
    expect(rotuloDoMotivo('novo_motivo')).toBe('novo_motivo')
  })
})
