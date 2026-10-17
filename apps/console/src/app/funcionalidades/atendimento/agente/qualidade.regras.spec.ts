import { describe, it, expect } from 'vitest'
import type { AvaliacaoQualidadeDto, ResumoQualidadeDto } from '@geracrm/shared'
import {
  amostraParaSalvar, badgeAcao, badgeGravidade, criteriosDaAvaliacao, formatarAmostra, formatarNota, mediasDoResumo,
  situacaoDoJuiz, textoDaAmostra, tomDaNota, linhaDaViolacao, mensagemDaFalha, parametrosDoFiltro,
} from './qualidade.regras.js'

const juiz = (j: Partial<ResumoQualidadeDto['juiz']> = {}): ResumoQualidadeDto['juiz'] =>
  ({ disponivel: true, motivoIndisponivel: null, gastoMesCentavos: 0, tetoMesCentavos: 2000, pausadoPorTeto: false, ...j })

describe('qualidade.regras', () => {
  it('gravidade e ação viram badge com tom fixo', () => {
    expect(badgeGravidade('CRITICA')).toEqual({ rotulo: 'Crítica', tom: 'erro' })
    expect(badgeGravidade(null).tom).toBe('sucesso')
    expect(badgeAcao('pausa_humano')?.tom).toBe('erro')
    expect(badgeAcao('registrado')).toBeNull()
  })

  it('nota: uma casa com vírgula; ≤ 3 atenção, ≥ 4 sucesso', () => {
    expect(formatarNota(3.8)).toBe('3,8')
    expect(formatarNota(null)).toBe('—')
    expect(tomDaNota(3)).toBe('atencao')
    expect(tomDaNota(4.2)).toBe('sucesso')
    expect(tomDaNota(3.5)).toBe('neutro')
  })

  it('amostra: % ↔ fração; vazio é o padrão do modo; fora de 0–100 é erro nomeado', () => {
    expect(amostraParaSalvar('20')).toEqual({ ok: true, valor: 0.2 })
    expect(amostraParaSalvar('5,5%')).toEqual({ ok: true, valor: 0.055 })
    expect(amostraParaSalvar(' ')).toEqual({ ok: true, valor: null })
    expect(amostraParaSalvar('120')).toMatchObject({ ok: false })
    expect(amostraParaSalvar('abc')).toMatchObject({ ok: false })
    expect(textoDaAmostra(0.055)).toBe('5,5')
    expect(textoDaAmostra(null)).toBe('')
    expect(formatarAmostra(0.05)).toBe('5%')
    expect(formatarAmostra(1)).toBe('100%')
  })

  it('situação do juiz deixa a degradação visível', () => {
    expect(situacaoDoJuiz(juiz())).toMatchObject({ rotulo: 'Juiz ativo', tom: 'sucesso' })
    expect(situacaoDoJuiz(juiz({ disponivel: false, motivoIndisponivel: 'Falta configurar: ANTHROPIC_API_KEY' })))
      .toMatchObject({ rotulo: 'Juiz indisponível', detalhe: 'Falta configurar: ANTHROPIC_API_KEY' })
    expect(situacaoDoJuiz(juiz({ pausadoPorTeto: true })).rotulo).toBe('Juiz no teto do mês')
    expect(situacaoDoJuiz(juiz({ tetoMesCentavos: 0 })).rotulo).toBe('Juiz desligado')
  })

  it('critérios na ordem da rubrica, e médias em barra 0–100%', () => {
    const notas = { aderencia: { nota: 4, justificativa: 'a' }, clareza: { nota: 5, justificativa: 'b' }, empatia: { nota: 3, justificativa: 'c' }, conducao: { nota: 2, justificativa: 'd' }, compliance: { nota: 5, justificativa: 'e' } }
    const a = { notas } as unknown as AvaliacaoQualidadeDto
    expect(criteriosDaAvaliacao(a).map((c) => [c.rotulo, c.nota])).toEqual([
      ['Aderência ao roteiro', 4], ['Clareza', 5], ['Empatia', 3], ['Condução', 2], ['Compliance', 5],
    ])
    expect(criteriosDaAvaliacao({ notas: null } as unknown as AvaliacaoQualidadeDto)).toEqual([])
    const r = { mediaPorCriterio: { aderencia: 2.5, clareza: null, empatia: 5, conducao: 0, compliance: 4 } } as unknown as ResumoQualidadeDto
    expect(mediasDoResumo(r).map((m) => m.largura)).toEqual([50, 0, 100, 0, 80])
  })

  it('violação numa linha e falhas com mensagem', () => {
    expect(linhaDaViolacao({ regra: 'palavra_proibida', gravidade: 'CRITICA', trecho: 'x', detalhe: 'venda_sem_nota' })).toBe('Frase proibida (venda_sem_nota)')
    expect(mensagemDaFalha('qualidade.teto_atingido', 'x')).toMatch(/teto/)
    expect(mensagemDaFalha('outro', 'padrão')).toBe('padrão')
  })

  it('filtro da tela → parâmetros da lista', () => {
    expect(parametrosDoFiltro('todas')).toEqual({})
    expect(parametrosDoFiltro('criticas')).toEqual({ gravidade: 'CRITICA' })
    expect(parametrosDoFiltro('juiz')).toEqual({ tipo: 'juiz' })
    expect(parametrosDoFiltro('achados')).toEqual({ comAchado: '1' })
  })
})
