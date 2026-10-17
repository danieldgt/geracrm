import { describe, it, expect } from 'vitest'
import { CRITERIOS_RUBRICA, somarConcordancia, type RevisaoDto, type RevisaoParaSomar } from '@geracrm/shared'
import {
  corpoDoFormulario, formatarPercentual, formularioDe, formularioVazio, progressoDaAmostra, resultadoDaRevisao,
  rotuloMotivo, rotuloSemana, semanaDeHoje, situacaoDaConcordancia,
} from './revisao.regras.js'

const todas = (n: number) => Object.fromEntries(CRITERIOS_RUBRICA.map((c) => [c, n])) as Record<(typeof CRITERIOS_RUBRICA)[number], number>
const rev = (concorda: boolean | null, extra: Partial<RevisaoParaSomar> = {}): RevisaoParaSomar => ({
  concorda, motivo: 'aleatoria', gravidade: true, falsoNegativoCritica: false,
  porCriterio: Object.fromEntries(CRITERIOS_RUBRICA.map((c) => [c, concorda])), ...extra,
})
const revisao = (r: Partial<RevisaoDto> = {}): RevisaoDto => ({
  id: 'r', avaliacaoId: 'a', revisorId: 'u', revisorNome: 'Gina', semana: '2026-W42', motivo: 'critica', notas: todas(4),
  gravidade: null, veredito: 'ok', decisao: 'nenhuma', responsavel: null, prazo: null, observacao: null, notasLlm: todas(4),
  gravidadeSistema: null, porCriterio: Object.fromEntries(CRITERIOS_RUBRICA.map((c) => [c, true])) as RevisaoDto['porCriterio'],
  concordaGravidade: true, concorda: true, falsoNegativoCritica: false, atualizadoEm: '2026-10-17T12:00:00Z', ...r,
})

describe('revisao.regras', () => {
  it('percentual com vírgula; sem valor vira travessão', () => {
    expect(formatarPercentual(0.85)).toBe('85%')
    expect(formatarPercentual(0.6667)).toBe('66,7%')
    expect(formatarPercentual(null)).toBe('—')
  })

  it('situação: sem revisões, poucas, crítica não vista, na meta, abaixo', () => {
    expect(situacaoDaConcordancia(somarConcordancia([])).rotulo).toBe('Sem revisões comparáveis')
    expect(situacaoDaConcordancia(somarConcordancia([rev(true)]))).toMatchObject({ rotulo: 'Poucas revisões', tom: 'atencao' })
    const vinte = Array.from({ length: 20 }, () => rev(true))
    expect(situacaoDaConcordancia(somarConcordancia(vinte))).toMatchObject({ rotulo: 'Na meta', tom: 'sucesso' })
    expect(situacaoDaConcordancia(somarConcordancia([...vinte.slice(0, 16), ...Array.from({ length: 4 }, () => rev(false))])))
      .toMatchObject({ rotulo: 'Abaixo da meta', tom: 'erro' })
    expect(situacaoDaConcordancia(somarConcordancia([...vinte, rev(true, { falsoNegativoCritica: true })])).rotulo).toBe('Crítica que o juiz não viu')
  })

  it('semana: rótulo no mesmo mês e cruzando o mês; semana de hoje', () => {
    expect(rotuloSemana('2026-W42', '2026-10-12')).toBe('Semana 42 · 12 a 18 de out.')
    expect(rotuloSemana('2026-W40', '2026-09-28')).toBe('Semana 40 · 28 de set. a 4 de out.')
    expect(semanaDeHoje(new Date(2026, 9, 17))).toBe('2026-W42')
    expect(rotuloMotivo('alta_ou_nota_baixa')).toBe('Alta ou nota ≤ 3')
  })

  it('formulário: exige as 5 notas, gravidade e veredito; decisão com ação pede responsável e prazo', () => {
    const vazio = corpoDoFormulario('a', formularioVazio())
    expect(vazio.ok).toBe(false)
    if (!vazio.ok) expect(Object.keys(vazio.erros).sort()).toEqual(['gravidade', 'notas', 'veredito'])
    const base = { ...formularioVazio(), notas: todas(3), gravidade: null, veredito: 'ajustar' as const }
    expect(corpoDoFormulario('a', base)).toEqual({ ok: true, corpo: {
      avaliacaoId: 'a', notas: todas(3), gravidade: null, veredito: 'ajustar', decisao: 'nenhuma', responsavel: null, prazo: null, observacao: null,
    } })
    const semDono = corpoDoFormulario('a', { ...base, decisao: 'nova_regra' })
    expect(semDono.ok).toBe(false)
    if (!semDono.ok) expect(Object.keys(semDono.erros).sort()).toEqual(['prazo', 'responsavel'])
    expect(corpoDoFormulario('a', { ...base, decisao: 'nova_regra', responsavel: ' Time ', prazo: '2026-10-24' }))
      .toMatchObject({ ok: true, corpo: { responsavel: 'Time', prazo: '2026-10-24' } })
  })

  it('a revisão gravada volta para o formulário; resultado diz onde divergiu', () => {
    expect(formularioDe(revisao({ gravidade: 'ALTA', responsavel: null }))).toMatchObject({ gravidade: 'ALTA', responsavel: '', notas: todas(4) })
    expect(resultadoDaRevisao(revisao()).tom).toBe('sucesso')
    expect(resultadoDaRevisao(revisao({ concorda: false, concordaGravidade: false, porCriterio: { ...revisao().porCriterio, clareza: false } })).rotulo)
      .toBe('Diverge do juiz em: Clareza, gravidade.')
    expect(resultadoDaRevisao(revisao({ concorda: null })).tom).toBe('neutro')
    expect(progressoDaAmostra([])).toEqual({ revisadas: 0, total: 0 })
  })
})
