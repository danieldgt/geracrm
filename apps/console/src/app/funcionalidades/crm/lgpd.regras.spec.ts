import { describe, expect, it } from 'vitest'
import { linhasPorMotivo, periodoDoMes, rotuloMotivo, type RelatorioAnonimizacao } from './lgpd.regras.js'

describe('regras LGPD do console', () => {
  it('período padrão é o mês corrente inteiro (fevereiro bissexto incluso)', () => {
    expect(periodoDoMes(new Date('2027-03-15T12:00:00Z'))).toEqual({ de: '2027-03-01', ate: '2027-03-31' })
    expect(periodoDoMes(new Date('2028-02-10T00:00:00Z'))).toEqual({ de: '2028-02-01', ate: '2028-02-29' })
  })

  it('linhas por motivo: ordem fixa e zero aparece', () => {
    const r: RelatorioAnonimizacao = {
      de: '', ate: '', total: 3, midiasPendentes: 0,
      porMotivo: { retencao: 2, opt_out: 0, titular: 1 }, porModo: { completa: 3, canais: 0 },
    }
    expect(linhasPorMotivo(r).map((l) => [l.motivo, l.total])).toEqual([['retencao', 2], ['opt_out', 0], ['titular', 1]])
    expect(rotuloMotivo('titular')).toBe('Pedido do titular')
  })
})
