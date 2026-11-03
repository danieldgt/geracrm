import { describe, expect, it } from 'vitest'
import {
  evidenciaValida, linhasPorMotivo, mensagemAnonimizado, periodoDoMes, resumoPrevia, rotuloBloqueio, rotuloMotivo,
  type RelatorioAnonimizacao,
} from './lgpd.regras.js'

describe('regras LGPD do console', () => {
  it('período padrão é o mês corrente inteiro (fevereiro bissexto incluso)', () => {
    expect(periodoDoMes(new Date('2027-03-15T12:00:00Z'))).toEqual({ de: '2027-03-01', ate: '2027-03-31' })
    expect(periodoDoMes(new Date('2028-02-10T00:00:00Z'))).toEqual({ de: '2028-02-01', ate: '2028-02-29' })
  })

  it('linhas por motivo: ordem fixa e zero aparece', () => {
    const r: RelatorioAnonimizacao = {
      de: '', ate: '', total: 3, midiasPendentes: 0, midiasRemovidas: 0, falhas: 0,
      porMotivo: { retencao: 2, opt_out: 0, titular: 1 }, porModo: { completa: 3, canais: 0 },
    }
    expect(linhasPorMotivo(r).map((l) => [l.motivo, l.total])).toEqual([['retencao', 2], ['opt_out', 0], ['titular', 1]])
    expect(rotuloMotivo('titular')).toBe('Pedido do titular')
  })

  it('só diz "apagado" sem pendência no armazenamento; senão, "em remoção"', () => {
    expect(mensagemAnonimizado(0)).toBe('Dados pessoais apagados.')
    expect(mensagemAnonimizado(1)).toContain('1 arquivo em remoção')
    expect(mensagemAnonimizado(3)).toContain('3 arquivos em remoção')
  })

  it('prévia da automática: zero, contagem e "mais de"', () => {
    expect(resumoPrevia({ total: 0, limitado: false, porMotivo: { retencao: 0, opt_out: 0 } })).toBe('Hoje nenhum contato seria anonimizado.')
    expect(resumoPrevia({ total: 3, limitado: false, porMotivo: { retencao: 2, opt_out: 1 } })).toContain('anonimizaria 3 contato(s): 2 pelo fim do prazo')
    expect(resumoPrevia({ total: 20000, limitado: true, porMotivo: { retencao: 10000, opt_out: 10000 } })).toContain('mais de 20000')
  })

  it('bloqueio LGPD aparece junto do motivo original; evidência tem tamanho', () => {
    expect(rotuloBloqueio('denuncia', true)).toBe('Denúncia · LGPD')
    expect(rotuloBloqueio('lgpd', true)).toBe('LGPD')
    expect(rotuloBloqueio('opt_out', false)).toBe('Pediu para sair')
    expect(evidenciaValida('  ok ')).toBe(false)
    expect(evidenciaValida('e-mail do titular de 03/11')).toBe(true)
  })
})
