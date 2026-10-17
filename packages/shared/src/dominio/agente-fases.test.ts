import { describe, it, expect } from 'vitest'
import {
  avaliarFase, faseDoModo, proximaFase, faseAnterior, diasUteisEntre, janelaDaFase, formatarPct, formatarCentavos,
  medido, indisponivel, CRITERIOS_DA_FASE, FONTES_DA_FASE, FASES_AGENTE,
  type EntradaFase, type MedidasFase, type FaseAgente,
} from './agente-fases.js'

/** Medidas que cumprem TODOS os alvos — cada caso estraga uma. */
const BOAS: MedidasFase = {
  douradas: medido({ cenarios: 25, criticas: 0 }),
  smoke: medido(true),
  playground: medido({ conversas: 30, criticas: 0 }),
  volume: medido({ turnos: 150, conversas: 50 }),
  criticas: medido(0),
  notaJuiz: medido({ media: 4.2, avaliadas: 40 }),
  concordancia: medido({ valor: 0.9, comparaveis: 20, falsosNegativosCritica: 0, atingeMeta: true }),
  similaridadeSombra: medido({ comparados: 100, taxaAcima: 0.6 }),
  custoPorConversa: medido({ centavos: 150, conversas: 50 }),
  numerosBloqueados: medido({ turnos: 100, comBloqueio: 2 }),
  sugestoes: medido({ geradas: 100, usadas: 50, taxaUso: 0.5, taxaSemEdicao: 0.7 }),
  latenciaPrimeira: medido({ p95Ms: 6000, amostras: 80 }),
  handoff: medido({ conversas: 100, comHandoff: 10 }),
  optOut: medido({ conversas: 100, comOptOut: 1 }),
  conversao: medido({ agente: { conversas: 100, convertidas: 18 }, humano: { conversas: 100, convertidas: 20 } }),
  pedidosErrados: medido({ confirmados: 12, cancelados: 0 }),
  slaHandoff: medido({ medidos: 10, cumpridos: 9, estourados: 1, pendentes: 0, respondidos: 10, pctCumprido: 90 }),
}

const entrada = (fase: FaseAgente, medidas: Partial<MedidasFase> = BOAS, dias = 30, uteis = 20): EntradaFase =>
  ({ fase, diasCorridos: dias, diasUteis: uteis, medidas })
const criterio = (fase: FaseAgente, id: string, m: Partial<MedidasFase>, dias = 30, uteis = 20) =>
  avaliarFase(entrada(fase, { ...BOAS, ...m }, dias, uteis)).criterios.find((c) => c.id === id)!

describe('Fase a partir do modo (P14: o mais restritivo vence)', () => {
  it.each([
    ['desligado', null, null, 'homologacao'],
    ['sombra', null, null, 'sombra'],
    ['assistido', null, null, 'assistido'],
    ['autonomo', null, null, 'autonomo_amplo'],
    ['autonomo', 'sombra', null, 'sombra'],
    ['autonomo', 'desligado', null, 'homologacao'],
    ['autonomo', null, { horario: { dias: ['seg'], de: '08:00', ate: '18:00' } }, 'autonomo_recorte'],
    ['autonomo', null, { segmentosRfv: ['campeoes'] }, 'autonomo_recorte'],
    ['autonomo', null, {}, 'autonomo_amplo'],
    ['autonomo', null, { lixo: 1 }, 'autonomo_recorte'],
    ['sombra', null, { segmentosRfv: ['campeoes'] }, 'sombra'],
  ] as const)('número %s, teto %s, recorte %j → %s', (modoNumero, modoTenant, recorte, fase) => {
    expect(faseDoModo({ modoNumero, modoTenant, recorte })).toBe(fase)
  })

  it('ordem das fases: próxima e anterior', () => {
    expect(proximaFase('homologacao')).toBe('sombra')
    expect(proximaFase('autonomo_recorte')).toBe('autonomo_amplo')
    expect(proximaFase('autonomo_amplo')).toBeNull()
    expect(faseAnterior('homologacao')).toBeNull()
    expect(faseAnterior('autonomo_amplo')).toBe('autonomo_recorte')
  })
})

describe('avaliarFase — com tudo nos alvos', () => {
  it.each(FASES_AGENTE.filter((f) => f !== 'autonomo_amplo'))('%s: verde, pode avançar', (fase) => {
    const r = avaliarFase(entrada(fase))
    expect(r.criterios.every((c) => c.ok === true)).toBe(true)
    expect(r.podeAvancar).toBe(true)
    expect(r.recomendacao).toBe('avancar')
    expect(r.proximaFase).toBe(proximaFase(fase))
  })

  it('autônomo amplo: verde, mantém (não há próxima)', () => {
    const r = avaliarFase(entrada('autonomo_amplo'))
    expect(r).toMatchObject({ podeAvancar: false, recomendacao: 'manter', proximaFase: null, voltarPara: null })
  })

  it('cada fase usa só as fontes que declara', () => {
    for (const f of FASES_AGENTE) {
      const so = Object.fromEntries(FONTES_DA_FASE[f].map((k) => [k, BOAS[k]])) as Partial<MedidasFase>
      expect(avaliarFase(entrada(f, so)).pendencias.indisponiveis).toEqual([])
      expect(CRITERIOS_DA_FASE[f].length).toBeGreaterThan(0)
    }
  })
})

describe('avaliarFase — cada alvo na fronteira', () => {
  it.each<[FaseAgente, string, Partial<MedidasFase>, boolean]>([
    ['homologacao', 'douradas', { douradas: medido({ cenarios: 24, criticas: 0 }) }, false],
    ['homologacao', 'douradas', { douradas: medido({ cenarios: 25, criticas: 1 }) }, false],
    ['homologacao', 'smoke', { smoke: medido(false) }, false],
    ['homologacao', 'playground_conversas', { playground: medido({ conversas: 29, criticas: 0 }) }, false],
    ['homologacao', 'playground_critica', { playground: medido({ conversas: 30, criticas: 1 }) }, false],
    ['sombra', 'turnos', { volume: medido({ turnos: 149, conversas: 50 }) }, false],
    ['sombra', 'conversas', { volume: medido({ turnos: 150, conversas: 49 }) }, false],
    ['sombra', 'similaridade_sombra', { similaridadeSombra: medido({ comparados: 100, taxaAcima: 0.59 }) }, false],
    ['sombra', 'similaridade_sombra', { similaridadeSombra: medido({ comparados: 0, taxaAcima: null }) }, false],
    ['sombra', 'critica', { criticas: medido(1) }, false],
    ['sombra', 'nota_juiz', { notaJuiz: medido({ media: 3.99, avaliadas: 40 }) }, false],
    ['sombra', 'nota_juiz', { notaJuiz: medido({ media: null, avaliadas: 0 }) }, false],
    ['sombra', 'concordancia', { concordancia: medido({ valor: 0.84, comparaveis: 20, falsosNegativosCritica: 0, atingeMeta: false }) }, false],
    ['sombra', 'custo_conversa', { custoPorConversa: medido({ centavos: 151, conversas: 50 }) }, false],
    ['sombra', 'numeros_bloqueados', { numerosBloqueados: medido({ turnos: 100, comBloqueio: 3 }) }, false],
    ['assistido', 'sugestoes', { sugestoes: medido({ geradas: 99, usadas: 50, taxaUso: 0.5, taxaSemEdicao: 0.7 }) }, false],
    ['assistido', 'uso_sugestao', { sugestoes: medido({ geradas: 100, usadas: 39, taxaUso: 0.39, taxaSemEdicao: 0.9 }) }, false],
    ['assistido', 'sem_edicao', { sugestoes: medido({ geradas: 100, usadas: 50, taxaUso: 0.5, taxaSemEdicao: 0.69 }) }, false],
    ['assistido', 'sem_edicao', { sugestoes: medido({ geradas: 100, usadas: 49, taxaUso: 0.49, taxaSemEdicao: 1 }) }, false],
    ['autonomo_recorte', 'p95_primeira', { latenciaPrimeira: medido({ p95Ms: 6001, amostras: 80 }) }, false],
    ['autonomo_recorte', 'handoff', { handoff: medido({ conversas: 100, comHandoff: 9 }) }, false],
    ['autonomo_recorte', 'handoff', { handoff: medido({ conversas: 100, comHandoff: 40 }) }, true],
    ['autonomo_recorte', 'handoff', { handoff: medido({ conversas: 100, comHandoff: 41 }) }, false],
    ['autonomo_recorte', 'opt_out', { optOut: medido({ conversas: 100, comOptOut: 2 }) }, false],
    ['autonomo_recorte', 'conversao', { conversao: medido({ agente: { conversas: 100, convertidas: 17 }, humano: { conversas: 100, convertidas: 20 } }) }, false],
    ['autonomo_recorte', 'conversao', { conversao: medido({ agente: { conversas: 29, convertidas: 20 }, humano: { conversas: 100, convertidas: 20 } }) }, false],
    ['autonomo_recorte', 'pedido_errado', { pedidosErrados: medido({ confirmados: 12, cancelados: 1 }) }, false],
    ['autonomo_recorte', 'sla_handoff', { slaHandoff: medido({ medidos: 10, cumpridos: 8, estourados: 2, pendentes: 0, respondidos: 10, pctCumprido: 80 }) }, false],
    ['autonomo_recorte', 'sla_handoff', { slaHandoff: medido({ medidos: 0, cumpridos: 0, estourados: 0, pendentes: 3, respondidos: 0, pctCumprido: null }) }, false],
  ])('%s · %s com %j → ok=%s', (fase, id, m, ok) => {
    expect(criterio(fase, id, m).ok).toBe(ok)
  })

  it('dias: sombra exige 10 dias ÚTEIS; recorte exige 21 dias corridos', () => {
    expect(criterio('sombra', 'dias_uteis', {}, 30, 9).ok).toBe(false)
    expect(criterio('sombra', 'dias_uteis', {}, 14, 10).ok).toBe(true)
    expect(criterio('autonomo_recorte', 'dias', {}, 20, 20).ok).toBe(false)
    expect(criterio('autonomo_recorte', 'dias', {}, 21, 15).ok).toBe(true)
  })

  it('nota do juiz não vale sem a concordância na meta (ADR-031 §5)', () => {
    const c = criterio('sombra', 'nota_juiz', { concordancia: medido({ valor: 0.5, comparaveis: 20, falsosNegativosCritica: 0, atingeMeta: false }) })
    expect(c.ok).toBe(false)
    expect(c.motivo).toMatch(/concordância/)
  })

  it('um critério reprovado segura o avanço e é nomeado', () => {
    const r = avaliarFase(entrada('sombra', { ...BOAS, criticas: medido(2) }))
    expect(r).toMatchObject({ podeAvancar: false, recomendacao: 'manter', pendencias: { reprovados: ['critica'], indisponiveis: [] } })
  })

  it('autônomo amplo com critério violado → volta uma fase', () => {
    const r = avaliarFase(entrada('autonomo_amplo', { ...BOAS, optOut: medido({ conversas: 100, comOptOut: 5 }) }))
    expect(r).toMatchObject({ recomendacao: 'voltar', voltarPara: 'autonomo_recorte', podeAvancar: false })
  })
})

describe('avaliarFase — degradação: fonte indisponível NÃO conta como cumprida', () => {
  it.each(FASES_AGENTE.flatMap((f) => FONTES_DA_FASE[f].map((k) => [f, k] as const)))('%s sem %s → indisponível, com motivo, sem avançar', (fase, chave) => {
    const r = avaliarFase(entrada(fase, { ...BOAS, [chave]: indisponivel(`fonte ${chave} fora`) }))
    const afetados = r.criterios.filter((c) => c.indisponivel)
    expect(afetados.length).toBeGreaterThan(0)
    for (const c of afetados) expect(c).toMatchObject({ ok: null, valor: null, motivo: `fonte ${chave} fora` })
    expect(r.podeAvancar).toBe(false)
    expect(r.pendencias.indisponiveis).toEqual(afetados.map((c) => c.id))
    // Os demais critérios continuam medidos.
    expect(r.criterios.filter((c) => !c.indisponivel).every((c) => c.ok !== null)).toBe(true)
  })

  it('medida não coletada também é indisponível (nunca "verde por omissão")', () => {
    const r = avaliarFase(entrada('assistido', {}))
    expect(r.criterios.filter((c) => c.id !== 'dias_uteis').every((c) => c.ok === null && c.motivo)).toBe(true)
    expect(r.podeAvancar).toBe(false)
  })

  it('amplo com fonte indisponível mantém, não manda voltar', () => {
    const r = avaliarFase(entrada('autonomo_amplo', { ...BOAS, slaHandoff: indisponivel('P18 ausente') }))
    expect(r.recomendacao).toBe('manter')
  })
})

describe('Apoio', () => {
  it('dias úteis completos: de segunda a segunda = 5; mesmo dia = 0', () => {
    expect(diasUteisEntre('2026-10-12', '2026-10-19')).toBe(5)
    expect(diasUteisEntre('2026-10-17', '2026-10-19')).toBe(0) // sáb → seg
    expect(diasUteisEntre('2026-10-19', '2026-10-19')).toBe(0)
    expect(diasUteisEntre('2026-10-20', '2026-10-19')).toBe(0)
    expect(diasUteisEntre('2026-09-28', '2026-10-26')).toBe(20)
  })

  it('janela: desde o início (1–90); recorte olha CRÍTICA em 14 dias; amplo revisa 30', () => {
    expect(janelaDaFase('sombra', 0)).toEqual({ dias: 1, diasCritica: 1 })
    expect(janelaDaFase('sombra', 200)).toEqual({ dias: 90, diasCritica: 90 })
    expect(janelaDaFase('autonomo_recorte', 25)).toEqual({ dias: 25, diasCritica: 14 })
    expect(janelaDaFase('autonomo_amplo', 300)).toEqual({ dias: 30, diasCritica: 30 })
  })

  it('formatação pt-BR', () => {
    expect(formatarPct(0.85)).toBe('85%')
    expect(formatarPct(0.123)).toBe('12,3%')
    expect(formatarPct(null)).toBe('—')
    expect(formatarCentavos(150)).toBe('R$ 1,50')
    expect(formatarCentavos(123456)).toBe('R$ 1.234,56')
  })
})
