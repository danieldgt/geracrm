import { describe, it, expect } from 'vitest'
import { CRITERIOS_RUBRICA, type CriterioRubrica } from './agente-qualidade.js'
import {
  calcularConcordancia, classeGravidade, corpoRevisao, deslocarSemana, segundaDaSemana, semanaDaData, somarConcordancia,
  type EntradaConcordancia, type RevisaoParaSomar,
} from './agente-revisao.js'

const todas = (n: number) => Object.fromEntries(CRITERIOS_RUBRICA.map((c) => [c, n])) as Record<CriterioRubrica, number>
const com = (base: number, c: CriterioRubrica, n: number) => ({ ...todas(base), [c]: n })

describe('Concordância juiz × humano (ADR-031): |LLM − humano| ≤ 1 por critério e mesma classe de gravidade', () => {
  const casos: ReadonlyArray<[string, EntradaConcordancia, boolean | null]> = [
    ['notas iguais, sem gravidade dos dois lados', { notasLlm: todas(4), notasHumanas: todas(4), gravidadeSistema: null, gravidadeHumana: null }, true],
    ['diferença de 1 em todos os critérios', { notasLlm: todas(4), notasHumanas: todas(3), gravidadeSistema: 'ALTA', gravidadeHumana: 'ALTA' }, true],
    ['diferença de 1 para baixo e para cima', { notasLlm: com(3, 'clareza', 5), notasHumanas: com(4, 'clareza', 4), gravidadeSistema: null, gravidadeHumana: null }, true],
    ['diferença de 2 num critério só', { notasLlm: com(4, 'compliance', 1), notasHumanas: com(4, 'compliance', 3),gravidadeSistema: null, gravidadeHumana: null }, false],
    ['0 × 5', { notasLlm: com(4, 'empatia', 0), notasHumanas: com(4, 'empatia', 5), gravidadeSistema: null, gravidadeHumana: null }, false],
    ['notas iguais, gravidade diferente (ALTA × MEDIA)', { notasLlm: todas(3), notasHumanas: todas(3), gravidadeSistema: 'ALTA', gravidadeHumana: 'MEDIA' }, false],
    ['sistema nenhuma × humano CRÍTICA', { notasLlm: todas(3), notasHumanas: todas(3), gravidadeSistema: null, gravidadeHumana: 'CRITICA' }, false],
    ['CRÍTICA × CRÍTICA com notas próximas', { notasLlm: todas(1), notasHumanas: todas(0), gravidadeSistema: 'CRITICA', gravidadeHumana: 'CRITICA' }, true],
    ['sem nota do juiz: não comparável', { notasLlm: null, notasHumanas: todas(4), gravidadeSistema: null, gravidadeHumana: null }, null],
    ['juiz sem um critério: não comparável', { notasLlm: { aderencia: 4, clareza: 4, empatia: 4, conducao: 4 }, notasHumanas: todas(4), gravidadeSistema: null, gravidadeHumana: null }, null],
  ]
  it.each(casos)('%s', (_nome, entrada, esperado) => {
    expect(calcularConcordancia(entrada).concorda).toBe(esperado)
  })

  it('detalha por critério e gravidade; falso negativo CRÍTICO quando só o humano viu', () => {
    const r = calcularConcordancia({ notasLlm: com(4, 'conducao', 1), notasHumanas: todas(4), gravidadeSistema: 'ALTA', gravidadeHumana: 'CRITICA' })
    expect(r.porCriterio).toEqual({ aderencia: true, clareza: true, empatia: true, conducao: false, compliance: true })
    expect(r.gravidade).toBe(false)
    expect(r.falsoNegativoCritica).toBe(true)
    expect(calcularConcordancia({ notasLlm: null, notasHumanas: todas(4), gravidadeSistema: 'CRITICA', gravidadeHumana: 'CRITICA' }).falsoNegativoCritica).toBe(false)
    expect(classeGravidade(null)).toBe('nenhuma')
    expect(classeGravidade(undefined)).toBe('nenhuma')
  })
})

describe('Soma da semana', () => {
  const rev = (concorda: boolean | null, motivo: RevisaoParaSomar['motivo'] = 'aleatoria', extra: Partial<RevisaoParaSomar> = {}): RevisaoParaSomar => ({
    conversaId: crypto.randomUUID(), semana: '2026-W42', criadoEm: '2026-10-13T10:00:00Z',
    concorda, motivo, gravidade: concorda !== false, falsoNegativoCritica: false,
    porCriterio: concorda === null ? {} : Object.fromEntries(CRITERIOS_RUBRICA.map((c) => [c, concorda])), ...extra,
  })

  it('concordantes ÷ comparáveis; não comparável fica fora do denominador', () => {
    const s = somarConcordancia([rev(true), rev(true), rev(false, 'critica'), rev(null)])
    expect(s).toMatchObject({ revisadas: 4, comparaveis: 3, concordantes: 2, concordancia: 0.6667, atingeMeta: false })
    expect(s.porCriterio.clareza).toBe(0.6667)
    expect(s.aleatorias).toEqual({ comparaveis: 2, concordancia: 1 })
    expect(s.gravidade).toBe(0.75)
  })

  it('meta: ≥ 85% com ≥ 20 comparáveis e nenhum falso negativo CRÍTICO', () => {
    const vinte = [...Array.from({ length: 17 }, () => rev(true)), ...Array.from({ length: 3 }, () => rev(false))]
    expect(somarConcordancia(vinte)).toMatchObject({ concordancia: 0.85, atingeMeta: true })
    expect(somarConcordancia(vinte.slice(1))).toMatchObject({ atingeMeta: false }) // 19 comparáveis
    expect(somarConcordancia([...vinte, rev(true, 'critica', { falsoNegativoCritica: true })]).atingeMeta).toBe(false)
  })

  it('uma por (conversa, semana): a 1ª comparável conta; dois revisores não dobram o peso nem o mínimo de 20', () => {
    const c = { conversaId: 'c1', semana: '2026-W42' }
    const primeira = rev(true, 'aleatoria', { ...c, criadoEm: '2026-10-13T10:00:00Z' })
    const depois = rev(false, 'aleatoria', { ...c, criadoEm: '2026-10-14T10:00:00Z' })
    const semJuizAntes = rev(null, 'aleatoria', { ...c, criadoEm: '2026-10-12T10:00:00Z' })
    expect(somarConcordancia([depois, primeira, semJuizAntes])).toMatchObject({ revisoes: 3, revisadas: 1, comparaveis: 1, conversasComparaveis: 1, concordancia: 1 })
    // Mesma conversa em outra semana é outra unidade.
    expect(somarConcordancia([primeira, { ...depois, semana: '2026-W43' }]).revisadas).toBe(2)
    // 20 linhas de 10 conversas (2 revisores cada) não atingem o mínimo.
    const dez = Array.from({ length: 10 }, (_, i) => [rev(true, 'aleatoria', { conversaId: `k${i}` }), rev(true, 'aleatoria', { conversaId: `k${i}`, criadoEm: '2026-10-15T00:00:00Z' })]).flat()
    expect(somarConcordancia(dez)).toMatchObject({ revisoes: 20, conversasComparaveis: 10, atingeMeta: false })
    // Falso negativo de QUALQUER revisor conta (uma vez por conversa).
    expect(somarConcordancia([primeira, { ...depois, falsoNegativoCritica: true }]).falsosNegativosCritica).toBe(1)
  })

  it('vazio: tudo null, sem meta', () => {
    expect(somarConcordancia([])).toMatchObject({ revisadas: 0, comparaveis: 0, concordancia: null, gravidade: null, atingeMeta: false })
  })
})

describe('Semana ISO', () => {
  it.each([
    ['2026-10-17', '2026-W42'], ['2026-10-12', '2026-W42'], ['2026-10-18', '2026-W42'], ['2026-10-19', '2026-W43'],
    ['2021-01-03', '2020-W53'], ['2024-12-30', '2025-W01'], ['2026-01-01', '2026-W01'],
  ])('%s → %s', (data, semana) => { expect(semanaDaData(data)).toBe(semana) })

  it('segunda da semana, ida e volta e semana inexistente', () => {
    expect(segundaDaSemana('2026-W42')).toBe('2026-10-12')
    expect(segundaDaSemana('2020-W53')).toBe('2020-12-28')
    expect(segundaDaSemana('2026-W53')).toBe('2026-12-28')
    expect(segundaDaSemana('2025-W53')).toBeNull()
    expect(segundaDaSemana('2026-42')).toBeNull()
    expect(semanaDaData('2026-02-30')).toBeNull()
    expect(deslocarSemana('2026-W01', -1)).toBe('2025-W52')
    expect(deslocarSemana('2026-W52', 1)).toBe('2026-W53')
    expect(deslocarSemana('2026-W42', 1)).toBe('2026-W43')
  })
})

describe('Corpo da revisão', () => {
  const base = { avaliacaoId: '01890000-0000-7000-8000-000000000001', notas: todas(4), gravidade: null, veredito: 'ok' }
  it('aceita o mínimo e normaliza vazios', () => {
    const r = corpoRevisao.parse({ ...base, responsavel: '', observacao: '  ' })
    expect(r).toMatchObject({ decisao: 'nenhuma', responsavel: null, prazo: null, observacao: null })
  })
  it('recusa nota fora de 0–5, critério a mais e tenant no corpo', () => {
    expect(corpoRevisao.safeParse({ ...base, notas: com(4, 'clareza', 6) }).success).toBe(false)
    expect(corpoRevisao.safeParse({ ...base, notas: { ...todas(4), extra: 1 } }).success).toBe(false)
    expect(corpoRevisao.safeParse({ ...base, tenantId: 'x' }).success).toBe(false)
  })
  it('decisão com ação exige responsável e prazo', () => {
    const r = corpoRevisao.safeParse({ ...base, decisao: 'nova_regra' })
    expect(r.success).toBe(false)
    expect(r.error?.issues.map((i) => i.path.join('.'))).toEqual(['responsavel', 'prazo'])
    expect(corpoRevisao.safeParse({ ...base, decisao: 'nova_regra', responsavel: 'Time técnico', prazo: '2026-10-24' }).success).toBe(true)
  })
})
