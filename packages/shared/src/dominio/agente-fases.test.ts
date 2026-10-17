import { describe, it, expect } from 'vitest'
import {
  avaliarFase, faseDoModo, pausadoPeloTeto, proximaFase, faseAnterior, diasUteisEntre, janelaDaFase, formatarPct, formatarCentavos,
  medido, indisponivel, wilson, diferencaNewcombe, amostraParaNaoInferioridade, julgarConversao, inicioDaFasePorAuditoria,
  corpoConferenciaGoLive, somarPlayground, msPausadosPeloTeto, CRITERIOS_DA_FASE, FONTES_DA_FASE, FASES_AGENTE,
  type EntradaFase, type MedidasFase, type FaseAgente, type MudancaDeConfig,
} from './agente-fases.js'

/** Medidas que cumprem TODOS os alvos, com amostra suficiente — cada caso estraga uma. */
const BOAS: MedidasFase = {
  douradas: medido({ cenarios: 25, criticas: 0, em: '2026-10-15T12:00:00.000Z', por: 'Ada' }),
  smoke: medido({ ok: true, em: '2026-10-15T12:00:00.000Z', por: null }),
  playground: medido({ conversas: 30, criticas: 0, corte: null }),
  volume: medido({ turnos: 150, conversas: 50 }),
  criticas: medido(0),
  notaJuiz: medido({ media: 4.2, avaliadas: 40 }),
  concordancia: medido({ valor: 0.9, comparaveis: 20, falsosNegativosCritica: 0 }),
  similaridadeSombra: medido({ comparados: 100, taxaAcima: 0.6 }),
  custoPorConversa: medido({ centavos: 150, conversas: 50, juizCentavos: 30 }),
  numerosBloqueados: medido({ turnos: 100, comBloqueio: 2 }),
  sugestoes: medido({ geradas: 100, usadas: 50, taxaUso: 0.5, taxaSemEdicao: 0.7 }),
  latenciaPrimeira: medido({ p95Ms: 6000, amostras: 80, semMedida: 0 }),
  handoff: medido({ conversas: 100, comHandoff: 10 }),
  optOut: medido({ conversas: 100, comOptOut: 1 }),
  // ~4950 por coorte é o poder de 80% para −2 p.p. com p = 20%.
  conversao: medido({ agente: { conversas: 6000, convertidas: 1200 }, humano: { conversas: 6000, convertidas: 1200 } }),
  pedidosErrados: medido({ confirmados: 12, cancelados: 0 }),
  slaHandoff: medido({ medidos: 10, cumpridos: 9, estourados: 1, pendentes: 0, respondidos: 10, pctCumprido: 90 }),
}

const entrada = (fase: FaseAgente, medidas: Partial<MedidasFase> = BOAS, dias = 30, uteis = 20): EntradaFase =>
  ({ fase, diasCorridos: dias, diasUteis: uteis, medidas })
const criterio = (fase: FaseAgente, id: string, m: Partial<MedidasFase>, dias = 30, uteis = 20) =>
  avaliarFase(entrada(fase, { ...BOAS, ...m }, dias, uteis)).criterios.find((c) => c.id === id)!

describe('Fase a partir do modo do NÚMERO (P14); o teto do tenant só pausa', () => {
  it.each([
    ['desligado', null, 'homologacao'],
    ['sombra', null, 'sombra'],
    ['assistido', null, 'assistido'],
    ['autonomo', null, 'autonomo_amplo'],
    ['autonomo', { horario: { dias: ['seg'], de: '08:00', ate: '18:00' } }, 'autonomo_recorte'],
    ['autonomo', { segmentosRfv: ['campeoes'] }, 'autonomo_recorte'],
    ['autonomo', {}, 'autonomo_amplo'],
    ['autonomo', { lixo: 1 }, 'autonomo_recorte'],
    ['sombra', { segmentosRfv: ['campeoes'] }, 'sombra'],
  ] as const)('número %s, recorte %j → %s', (modoNumero, recorte, fase) => {
    expect(faseDoModo({ modoNumero, recorte })).toBe(fase)
  })

  it('kill switch: teto abaixo do número = pausado; igual ou acima, não', () => {
    expect(pausadoPeloTeto('autonomo', 'sombra')).toBe(true)
    expect(pausadoPeloTeto('sombra', 'sombra')).toBe(false)
    expect(pausadoPeloTeto('sombra', 'autonomo')).toBe(false)
    expect(pausadoPeloTeto('autonomo', null)).toBe(false)
  })

  it('ordem das fases: próxima e anterior', () => {
    expect(proximaFase('homologacao')).toBe('sombra')
    expect(proximaFase('autonomo_amplo')).toBeNull()
    expect(faseAnterior('autonomo_amplo')).toBe('autonomo_recorte')
    expect(faseAnterior('homologacao')).toBeNull()
  })
})

describe('Início da fase: só a mudança que TROCA a fase reinicia a contagem (M4)', () => {
  const m = (em: string, antes: Record<string, unknown>, depois: Record<string, unknown>, criacao = false): MudancaDeConfig => ({ em, antes, depois, criacao })
  const RECORTE = { horario: { dias: ['seg'], de: '08:00', ate: '18:00' } }

  it('ajuste de recorte que mantém a fase não reinicia; a troca de modo anterior é o início', () => {
    const r = inicioDaFasePorAuditoria({ modoNumero: 'autonomo', recorte: { ...RECORTE, foraDoRecorte: 'assistido' } }, [
      m('2026-10-10', { recorte: RECORTE }, { recorte: { ...RECORTE, foraDoRecorte: 'assistido' } }),
      m('2026-10-05', { politicas: { tamanho: 1 } }, { politicas: { tamanho: 2 } }),
      m('2026-09-20', { modo: 'assistido' }, { modo: 'autonomo' }),
    ])
    expect(r).toBe('2026-09-20')
  })

  it('tirar o recorte troca recorte → amplo: reinicia', () => {
    expect(inicioDaFasePorAuditoria({ modoNumero: 'autonomo', recorte: null }, [m('2026-10-12', { recorte: RECORTE }, { recorte: null })])).toBe('2026-10-12')
  })

  it('criação da configuração (desligado → sombra) é o início', () => {
    expect(inicioDaFasePorAuditoria({ modoNumero: 'sombra', recorte: null }, [m('2026-10-01', {}, { modo: 'sombra' }, true)])).toBe('2026-10-01')
  })

  it('nenhuma mudança que troca a fase → null (quem chama estima)', () => {
    expect(inicioDaFasePorAuditoria({ modoNumero: 'sombra', recorte: null }, [m('2026-10-01', { persona: 'a' }, { persona: 'b' })])).toBeNull()
    expect(inicioDaFasePorAuditoria({ modoNumero: 'sombra', recorte: null }, [])).toBeNull()
  })
})

describe('avaliarFase — com tudo nos alvos', () => {
  it.each(FASES_AGENTE.filter((f) => f !== 'autonomo_amplo'))('%s: verde, pode avançar', (fase) => {
    const r = avaliarFase(entrada(fase))
    expect(r.criterios.filter((c) => c.ok !== true)).toEqual([])
    expect(r).toMatchObject({ podeAvancar: true, recomendacao: 'avancar', proximaFase: proximaFase(fase) })
  })

  it('autônomo amplo: verde, mantém (não há próxima)', () => {
    expect(avaliarFase(entrada('autonomo_amplo'))).toMatchObject({ podeAvancar: false, recomendacao: 'manter', proximaFase: null, voltarPara: null })
  })

  it('cada fase usa só as fontes que declara', () => {
    for (const f of FASES_AGENTE) {
      const so = Object.fromEntries(FONTES_DA_FASE[f].map((k) => [k, BOAS[k]])) as Partial<MedidasFase>
      expect(avaliarFase(entrada(f, so)).pendencias.indisponiveis).toEqual([])
      expect(CRITERIOS_DA_FASE[f].length).toBeGreaterThan(0)
    }
  })
})

describe('avaliarFase — REPROVA só com medida e amostra (ok = false)', () => {
  it.each<[FaseAgente, string, Partial<MedidasFase>]>([
    ['homologacao', 'douradas', { douradas: medido({ cenarios: 24, criticas: 0, em: '2026-10-15T00:00:00Z', por: null }) }],
    ['homologacao', 'douradas', { douradas: medido({ cenarios: 25, criticas: 1, em: '2026-10-15T00:00:00Z', por: null }) }],
    ['homologacao', 'smoke', { smoke: medido({ ok: false, em: '2026-10-15T00:00:00Z', por: null }) }],
    ['homologacao', 'playground_conversas', { playground: medido({ conversas: 29, criticas: 0, corte: null }) }],
    ['homologacao', 'playground_critica', { playground: medido({ conversas: 30, criticas: 1, corte: null }) }],
    ['sombra', 'turnos', { volume: medido({ turnos: 149, conversas: 50 }) }],
    ['sombra', 'conversas', { volume: medido({ turnos: 150, conversas: 49 }) }],
    ['sombra', 'similaridade_sombra', { similaridadeSombra: medido({ comparados: 100, taxaAcima: 0.59 }) }],
    ['sombra', 'critica', { criticas: medido(1) }],
    ['sombra', 'nota_juiz', { notaJuiz: medido({ media: 3.99, avaliadas: 40 }) }],
    ['sombra', 'concordancia', { concordancia: medido({ valor: 0.84, comparaveis: 20, falsosNegativosCritica: 0 }) }],
    ['sombra', 'concordancia', { concordancia: medido({ valor: 1, comparaveis: 3, falsosNegativosCritica: 1 }) }],
    ['sombra', 'custo_conversa', { custoPorConversa: medido({ centavos: 151, conversas: 50, juizCentavos: 0 }) }],
    ['sombra', 'numeros_bloqueados', { numerosBloqueados: medido({ turnos: 100, comBloqueio: 3 }) }],
    ['assistido', 'sugestoes', { sugestoes: medido({ geradas: 99, usadas: 50, taxaUso: 0.5, taxaSemEdicao: 0.7 }) }],
    ['assistido', 'uso_sugestao', { sugestoes: medido({ geradas: 100, usadas: 39, taxaUso: 0.39, taxaSemEdicao: 0.9 }) }],
    ['assistido', 'sem_edicao', { sugestoes: medido({ geradas: 100, usadas: 50, taxaUso: 0.5, taxaSemEdicao: 0.69 }) }],
    ['autonomo_recorte', 'p95_primeira', { latenciaPrimeira: medido({ p95Ms: 6001, amostras: 80, semMedida: 0 }) }],
    ['autonomo_recorte', 'handoff', { handoff: medido({ conversas: 100, comHandoff: 9 }) }],
    ['autonomo_recorte', 'handoff', { handoff: medido({ conversas: 100, comHandoff: 41 }) }],
    ['autonomo_recorte', 'opt_out', { optOut: medido({ conversas: 100, comOptOut: 2 }) }],
    ['autonomo_recorte', 'conversao', { conversao: medido({ agente: { conversas: 6000, convertidas: 1000 }, humano: { conversas: 6000, convertidas: 1200 } }) }],
    ['autonomo_recorte', 'pedido_errado', { pedidosErrados: medido({ confirmados: 12, cancelados: 1 }) }],
    ['autonomo_recorte', 'sla_handoff', { slaHandoff: medido({ medidos: 10, cumpridos: 8, estourados: 2, pendentes: 0, respondidos: 10, pctCumprido: 80 }) }],
  ])('%s · %s com %j → reprova', (fase, id, m) => {
    expect(criterio(fase, id, m).ok).toBe(false)
  })

  it('fronteiras que cumprem: handoff 40%, SLA exatamente 90%', () => {
    expect(criterio('autonomo_recorte', 'handoff', { handoff: medido({ conversas: 100, comHandoff: 40 }) }).ok).toBe(true)
    expect(criterio('autonomo_recorte', 'sla_handoff', {}).ok).toBe(true)
  })

  it('SLA compara cumpridos ÷ medidos SEM arredondar: 89,6% não passa (o pctCumprido arredondado diria 90)', () => {
    const c = criterio('autonomo_recorte', 'sla_handoff', { slaHandoff: medido({ medidos: 1000, cumpridos: 896, estourados: 104, pendentes: 0, respondidos: 1000, pctCumprido: 90 }) })
    expect(c).toMatchObject({ ok: false, valor: '89,6% de 1000' })
  })

  it('dias: sombra exige 10 dias ÚTEIS; recorte exige 21 dias corridos', () => {
    expect(criterio('sombra', 'dias_uteis', {}, 30, 9).ok).toBe(false)
    expect(criterio('sombra', 'dias_uteis', {}, 14, 10).ok).toBe(true)
    expect(criterio('autonomo_recorte', 'dias', {}, 20, 20).ok).toBe(false)
    expect(criterio('autonomo_recorte', 'dias', {}, 21, 15).ok).toBe(true)
  })

  it('um critério reprovado segura o avanço e é nomeado', () => {
    const r = avaliarFase(entrada('sombra', { ...BOAS, criticas: medido(2) }))
    expect(r).toMatchObject({ podeAvancar: false, recomendacao: 'manter', pendencias: { reprovados: ['critica'], indisponiveis: [], alertas: [] } })
  })

  it('autônomo amplo com reprovação de verdade → volta uma fase', () => {
    const r = avaliarFase(entrada('autonomo_amplo', { ...BOAS, optOut: medido({ conversas: 100, comOptOut: 5 }) }))
    expect(r).toMatchObject({ recomendacao: 'voltar', voltarPara: 'autonomo_recorte', podeAvancar: false })
  })
})

describe('A1 — falta de AMOSTRA é "sem medida" (ok = null) com motivo, nunca reprovação', () => {
  it.each<[FaseAgente, string, Partial<MedidasFase>, RegExp]>([
    ['homologacao', 'playground_critica', { playground: medido({ conversas: 0, criticas: 0, corte: null }) }, /Nenhuma conversa/],
    ['sombra', 'similaridade_sombra', { similaridadeSombra: medido({ comparados: 0, taxaAcima: null }) }, /nada para comparar/],
    ['sombra', 'nota_juiz', { notaJuiz: medido({ media: null, avaliadas: 0 }) }, /Nenhuma conversa avaliada/],
    ['sombra', 'concordancia', { concordancia: medido({ valor: 1, comparaveis: 19, falsosNegativosCritica: 0 }) }, /19 de 20/],
    ['sombra', 'custo_conversa', { custoPorConversa: medido({ centavos: null, conversas: 0, juizCentavos: 0 }) }, /Nenhuma conversa/],
    ['sombra', 'numeros_bloqueados', { numerosBloqueados: medido({ turnos: 0, comBloqueio: 0 }) }, /Nenhum turno/],
    ['assistido', 'uso_sugestao', { sugestoes: medido({ geradas: 0, usadas: 0, taxaUso: null, taxaSemEdicao: null }) }, /Nenhuma sugestão/],
    ['assistido', 'sem_edicao', { sugestoes: medido({ geradas: 100, usadas: 49, taxaUso: 0.49, taxaSemEdicao: 1 }) }, /49 de 50/],
    ['autonomo_recorte', 'p95_primeira', { latenciaPrimeira: medido({ p95Ms: null, amostras: 0, semMedida: 0 }) }, /Nenhuma 1ª resposta/],
    ['autonomo_recorte', 'handoff', { handoff: medido({ conversas: 0, comHandoff: 0 }) }, /Nenhuma conversa/],
    ['autonomo_recorte', 'opt_out', { optOut: medido({ conversas: 0, comOptOut: 0 }) }, /Nenhuma conversa/],
    ['autonomo_recorte', 'conversao', { conversao: medido({ agente: { conversas: 40, convertidas: 8 }, humano: { conversas: 0, convertidas: 0 } }) }, /coorte madura/],
    ['autonomo_recorte', 'pedido_errado', { pedidosErrados: medido({ confirmados: 0, cancelados: 0 }) }, /Nenhum pedido/],
    ['autonomo_recorte', 'sla_handoff', { slaHandoff: medido({ medidos: 0, cumpridos: 0, estourados: 0, pendentes: 3, respondidos: 0, pctCumprido: null }) }, /3 ainda no prazo/],
  ])('%s · %s → sem medida', (fase, id, m, motivo) => {
    const c = criterio(fase, id, m)
    expect(c).toMatchObject({ ok: null, indisponivel: true })
    expect(c.motivo).toMatch(motivo)
  })

  it('autônomo amplo com 0 conversas humanas → mantém (não manda voltar)', () => {
    const r = avaliarFase(entrada('autonomo_amplo', {
      ...BOAS, conversao: medido({ agente: { conversas: 300, convertidas: 30 }, humano: { conversas: 0, convertidas: 0 } }),
    }))
    expect(r.criterios.find((c) => c.id === 'conversao')!.ok).toBeNull()
    expect(r).toMatchObject({ recomendacao: 'manter', voltarPara: null, pendencias: { reprovados: [], indisponiveis: ['conversao'] } })
  })

  it('amplo com todas as amostras vazias → mantém', () => {
    const r = avaliarFase(entrada('autonomo_amplo', {
      criticas: medido(0), latenciaPrimeira: medido({ p95Ms: null, amostras: 0, semMedida: 0 }), handoff: medido({ conversas: 0, comHandoff: 0 }),
      optOut: medido({ conversas: 0, comOptOut: 0 }), conversao: medido({ agente: { conversas: 0, convertidas: 0 }, humano: { conversas: 0, convertidas: 0 } }),
      pedidosErrados: medido({ confirmados: 0, cancelados: 0 }),
      slaHandoff: medido({ medidos: 0, cumpridos: 0, estourados: 0, pendentes: 0, respondidos: 0, pctCumprido: null }),
    }))
    expect(r.recomendacao).toBe('manter')
  })

  it('nota do juiz não vale sem a concordância na meta: sem medida, mostrando o valor', () => {
    const c = criterio('sombra', 'nota_juiz', { concordancia: medido({ valor: 0.5, comparaveis: 20, falsosNegativosCritica: 0 }) })
    expect(c).toMatchObject({ ok: null, valor: '4,20 em 40' })
    expect(c.motivo).toMatch(/ADR-031/)
  })
})

describe('M3 — pedido desfeito no autônomo amplo é ALERTA (revisar), não reprovação', () => {
  it('amplo: cumpre, com alerta e motivo de aproximação; recomendação continua manter', () => {
    const r = avaliarFase(entrada('autonomo_amplo', { ...BOAS, pedidosErrados: medido({ confirmados: 12, cancelados: 2 }) }))
    const c = r.criterios.find((x) => x.id === 'pedido_errado')!
    expect(c).toMatchObject({ ok: true, alerta: expect.stringMatching(/Revise os 2 pedidos/) })
    expect(c.motivo).toMatch(/Aproximação/)
    expect(r).toMatchObject({ recomendacao: 'manter', pendencias: { alertas: ['pedido_errado'], reprovados: [] } })
  })
  it('recorte: o mesmo número reprova (critério de saída da fase)', () => {
    expect(criterio('autonomo_recorte', 'pedido_errado', { pedidosErrados: medido({ confirmados: 12, cancelados: 2 }) }).ok).toBe(false)
  })
})

describe('Degradação: fonte indisponível NÃO conta como cumprida', () => {
  it.each(FASES_AGENTE.flatMap((f) => FONTES_DA_FASE[f].map((k) => [f, k] as const)))('%s sem %s → sem medida, com motivo, sem avançar', (fase, chave) => {
    const r = avaliarFase(entrada(fase, { ...BOAS, [chave]: indisponivel(`fonte ${chave} fora`) }))
    const afetados = r.criterios.filter((c) => c.indisponivel)
    expect(afetados.length).toBeGreaterThan(0)
    for (const c of afetados) expect(c.ok).toBeNull()
    expect(afetados.some((c) => c.motivo === `fonte ${chave} fora`)).toBe(true)
    expect(r.podeAvancar).toBe(false)
    expect(r.recomendacao).not.toBe('voltar')
  })

  it('medida não coletada também é sem medida (nunca "verde por omissão")', () => {
    const r = avaliarFase(entrada('assistido', {}))
    expect(r.criterios.filter((c) => c.id !== 'dias_uteis').every((c) => c.ok === null && c.motivo)).toBe(true)
    expect(r.podeAvancar).toBe(false)
  })
})

describe('Final A — conversão sem poder estatístico NÃO bloqueia: cumpre com alerta', () => {
  it('recorte com 200 conversas por coorte e diferença pequena → pode avançar, com alerta mostrando limite inferior e n', () => {
    const r = avaliarFase(entrada('autonomo_recorte', {
      ...BOAS, conversao: medido({ agente: { conversas: 200, convertidas: 38 }, humano: { conversas: 200, convertidas: 40 } }),
    }))
    const c = r.criterios.find((x) => x.id === 'conversao')!
    expect(c.ok).toBe(true)
    expect(c.alerta).toMatch(/Amostra sem poder para −2,0 p\.p\.; leitura indicativa \(limite inferior −?\d+,\d p\.p\., n 200 × 200/)
    expect(r).toMatchObject({ podeAvancar: true, recomendacao: 'avancar', pendencias: { alertas: ['conversao'], reprovados: [] } })
  })

  it('nenhum texto da conversão tem "p.p.." (ponto duplo)', () => {
    for (const [a, h] of [[[200, 38], [200, 40]], [[300, 15], [300, 90]], [[6000, 1190], [6000, 1200]]] as const) {
      const j = julgarConversao({ conversas: a[0], convertidas: a[1] }, { conversas: h[0], convertidas: h[1] })
      for (const t of [j.valor, j.motivo, j.alerta]) expect(t ?? '').not.toMatch(/p\.p\.\./)
    }
    const alvo = CRITERIOS_DA_FASE.autonomo_recorte.map((f) => f(entrada('autonomo_recorte'))).find((c) => c.id === 'conversao')!.alvo
    expect(alvo).not.toMatch(/p\.p\.\./)
  })
})

describe('Final B — playground: entradas por reinício, corte e mínimo de 3 decisões', () => {
  const agora = '2026-10-17T12:00:00.000Z'
  const e = (dias: number, turnos: number, criticas: number) => ({ em: new Date(Date.parse(agora) - dias * 86_400_000).toISOString(), turnos, criticas })
  it('conversa com < 3 decisões não conta; CRÍTICA conta; mais de 30 dias não conta', () => {
    expect(somarPlayground([e(1, 3, 0), e(2, 2, 1), e(31, 5, 1)], { agora, corte: null })).toEqual({ conversas: 1, criticas: 1 })
  })
  it('CRÍTICA antiga deixa de contar depois do corte (nova publicação do playbook)', () => {
    const entradas = [e(5, 4, 1), e(1, 4, 0)]
    expect(somarPlayground(entradas, { agora, corte: null })).toEqual({ conversas: 2, criticas: 1 })
    expect(somarPlayground(entradas, { agora, corte: new Date(Date.parse(agora) - 3 * 86_400_000).toISOString() })).toEqual({ conversas: 1, criticas: 0 })
  })
})

describe('Baixa — dias pausados pelo teto não contam na fase', () => {
  const inicio = '2026-10-01T00:00:00.000Z', agora = '2026-10-21T00:00:00.000Z'
  const D = 86_400_000
  it('pausa de 5 dias no meio (teto sombra sobre número autônomo) → 5 dias', () => {
    // 10/10 o teto foi a sombra (antes: sem teto); 15/10 voltou (antes: sombra).
    const ms = msPausadosPeloTeto({ inicio, agora, modoNumero: 'autonomo', tetoAtual: null, mudancas: [
      { em: '2026-10-15T00:00:00.000Z', antes: 'sombra' }, { em: '2026-10-10T00:00:00.000Z', antes: null },
    ] })
    expect(ms).toBe(5 * D)
  })
  it('pausado até agora conta até agora; teto igual ou acima do número não pausa', () => {
    expect(msPausadosPeloTeto({ inicio, agora, modoNumero: 'autonomo', tetoAtual: 'sombra', mudancas: [{ em: '2026-10-18T00:00:00.000Z', antes: null }] })).toBe(3 * D)
    expect(msPausadosPeloTeto({ inicio, agora, modoNumero: 'sombra', tetoAtual: 'sombra', mudancas: [] })).toBe(0)
  })
  it('pausa que começou antes da fase só conta a parte dentro dela', () => {
    expect(msPausadosPeloTeto({ inicio, agora, modoNumero: 'assistido', tetoAtual: null, mudancas: [
      { em: '2026-10-03T00:00:00.000Z', antes: 'sombra' }, { em: '2026-09-20T00:00:00.000Z', antes: null },
    ] })).toBe(2 * D)
  })
})

describe('M2 — estatística da conversão', () => {
  it('Wilson: 0 de 10 não dá intervalo degenerado; n = 0 é [0, 1]', () => {
    const w = wilson(0, 10)
    expect(w.inf).toBe(0)
    expect(w.sup).toBeGreaterThan(0.15)
    expect(wilson(0, 0)).toEqual({ inf: 0, sup: 1 })
  })

  it('Newcombe: referência (Newcombe 1998, 56/70 × 48/80, IC 95% bilateral −0,0524..0,3339 → z = 1,96)', () => {
    const d = diferencaNewcombe({ x: 56, n: 70 }, { x: 48, n: 80 }, 1.959963984540054)
    expect(d.diferenca).toBeCloseTo(0.2, 6)
    expect(d.inf).toBeCloseTo(0.0524, 3)
    expect(d.sup).toBeCloseTo(0.3339, 3)
  })

  it('amostra para poder 80% com margem de 2 p.p. e p = 20%: ~4950 por coorte', () => {
    expect(amostraParaNaoInferioridade(0.2)).toBeGreaterThan(4900)
    expect(amostraParaNaoInferioridade(0.2)).toBeLessThan(5000)
  })

  it('inferioridade clara reprova mesmo com amostra pequena; o motivo nomeia o viés de seleção', () => {
    const r = julgarConversao({ conversas: 300, convertidas: 15 }, { conversas: 300, convertidas: 90 })
    expect(r.ok).toBe(false)
    expect(r.motivo).toMatch(/viés de seleção/)
  })

  it('critério manual mostra quem declarou e quando', () => {
    const c = avaliarFase(entrada('homologacao')).criterios.find((x) => x.id === 'douradas')!
    expect(c.motivo).toBe('Declarado por Ada em 15/10 (vale 30 dias).')
  })

  it('p95 expõe quantas sessões ficaram sem medida', () => {
    const c = avaliarFase(entrada('autonomo_recorte', { ...BOAS, latenciaPrimeira: medido({ p95Ms: 2000, amostras: 10, semMedida: 2 }) })).criterios.find((x) => x.id === 'p95_primeira')!
    expect(c.motivo).toMatch(/2 sessões ficaram sem medida/)
  })

  it('não-inferior com poder: cumpre, e ainda avisa do viés', () => {
    const r = julgarConversao({ conversas: 6000, convertidas: 1190 }, { conversas: 6000, convertidas: 1200 })
    expect(r.ok).toBe(true)
    expect(r.motivo).toMatch(/viés de seleção/)
  })
})

describe('Conferência de homologação (corpo)', () => {
  const canalId = '0199e000-0000-7000-8000-000000000001'
  it('douradas: cenários ≥ 1 e CRÍTICAs ≤ cenários; smoke: ok booleano; playground não se registra à mão', () => {
    expect(corpoConferenciaGoLive.safeParse({ item: 'douradas', canalId, cenarios: 25, criticas: 0 }).success).toBe(true)
    expect(corpoConferenciaGoLive.safeParse({ item: 'douradas', canalId, cenarios: 2, criticas: 3 }).success).toBe(false)
    expect(corpoConferenciaGoLive.safeParse({ item: 'douradas', canalId, cenarios: 0, criticas: 0 }).success).toBe(false)
    expect(corpoConferenciaGoLive.safeParse({ item: 'smoke', canalId, ok: true }).success).toBe(true)
    expect(corpoConferenciaGoLive.safeParse({ item: 'smoke', canalId, ok: 'sim' }).success).toBe(false)
    expect(corpoConferenciaGoLive.safeParse({ item: 'playground', canalId, conversas: 30 }).success).toBe(false)
    expect(corpoConferenciaGoLive.safeParse({ item: 'smoke', canalId, ok: true, tenantId: 'x' }).success).toBe(false)
  })
})

describe('Apoio', () => {
  it('dias úteis completos', () => {
    expect(diasUteisEntre('2026-10-12', '2026-10-19')).toBe(5)
    expect(diasUteisEntre('2026-10-17', '2026-10-19')).toBe(0)
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
    expect(formatarCentavos(123456)).toBe('R$ 1.234,56')
  })
})
