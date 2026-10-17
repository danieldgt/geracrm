import { describe, it, expect } from 'vitest'
import {
  COMPLEMENTO_AVISO_FORA, SLA_PADRAO, TEXTO_AVISO_ESPERA, falaDoProximoHorario, TEXTO_AVISO_ESPERA_FORA, corpoSlaConfig, duracaoCurta, faixaDoCronometro,
  renderizarAvisoEspera, rotearHandoff, type PessoaRoteavel,
} from './agente-sla.js'
import { ajustarMensagemHandoff, filtrarSaida } from './agente-filtro.js'
import { verificarNumerosNaResposta } from './agente-vendedor.js'

const p = (id: string, extra: Partial<PessoaRoteavel> = {}): PessoaRoteavel => ({ id, ativo: true, ausente: false, ...extra })

describe('rotearHandoff — dono da carteira → pool em rodízio → gestor', () => {
  const casos: Array<[string, Parameters<typeof rotearHandoff>[0], ReturnType<typeof rotearHandoff>]> = [
    ['dono ativo leva', { donoCarteira: p('d'), pool: [p('a')], ultimoDoRodizio: null, gestores: [p('g')] }, { destino: 'dono_carteira', usuarioId: 'd' }],
    ['dono inativo cai no pool', { donoCarteira: p('d', { ativo: false }), pool: [p('a')], ultimoDoRodizio: null, gestores: [] }, { destino: 'pool', usuarioId: 'a' }],
    ['dono ausente cai no pool', { donoCarteira: p('d', { ausente: true }), pool: [p('b'), p('a')], ultimoDoRodizio: null, gestores: [] }, { destino: 'pool', usuarioId: 'a' }],
    ['rodízio: o próximo depois do último', { donoCarteira: null, pool: [p('c'), p('a'), p('b')], ultimoDoRodizio: 'a', gestores: [] }, { destino: 'pool', usuarioId: 'b' }],
    ['rodízio: volta ao primeiro no fim', { donoCarteira: null, pool: [p('a'), p('b')], ultimoDoRodizio: 'b', gestores: [] }, { destino: 'pool', usuarioId: 'a' }],
    ['rodízio: último saiu do pool, segue a ordem', { donoCarteira: null, pool: [p('a'), p('c')], ultimoDoRodizio: 'b', gestores: [] }, { destino: 'pool', usuarioId: 'c' }],
    ['rodízio pula ausente', { donoCarteira: null, pool: [p('a'), p('b', { ausente: true }), p('c')], ultimoDoRodizio: 'a', gestores: [] }, { destino: 'pool', usuarioId: 'c' }],
    ['pool todo fora → gestor', { donoCarteira: null, pool: [p('a', { ativo: false })], ultimoDoRodizio: null, gestores: [p('g1', { ausente: true }), p('g2')] }, { destino: 'gestor', usuarioId: 'g2' }],
    ['ninguém', { donoCarteira: null, pool: [], ultimoDoRodizio: null, gestores: [] }, { destino: 'ninguem', usuarioId: null }],
  ]
  it.each(casos)('%s', (_n, entrada, esperado) => {
    expect(rotearHandoff(entrada)).toEqual(esperado)
  })
})

describe('faixaDoCronometro — verde → amarelo → vermelho', () => {
  const base = { inicioEm: '2026-10-19T12:00:00Z', venceEm: '2026-10-19T12:30:00Z', respondidoEm: null, estouradoEm: null }
  it.each([
    ['12:00', 'verde'], ['12:19', 'verde'], ['12:20', 'amarelo'], ['12:29', 'amarelo'], ['12:30', 'vermelho'], ['13:10', 'vermelho'],
  ] as const)('%s → %s', (hora, faixa) => {
    expect(faixaDoCronometro(base, new Date(`2026-10-19T${hora}:00Z`))).toBe(faixa)
  })
  it('estourado gravado é vermelho mesmo com relógio local atrasado', () => {
    expect(faixaDoCronometro({ ...base, estouradoEm: '2026-10-19T12:30:00Z' }, new Date('2026-10-19T12:05:00Z'))).toBe('vermelho')
  })
  it('respondido pára o relógio', () => {
    expect(faixaDoCronometro({ ...base, respondidoEm: '2026-10-19T12:40:00Z' }, new Date('2026-10-19T13:00:00Z'))).toBe('respondido')
  })
})

describe('textos fixos da espera', () => {
  it.each([TEXTO_AVISO_ESPERA, TEXTO_AVISO_ESPERA_FORA, COMPLEMENTO_AVISO_FORA])('passa no filtro P2, na rede de R$ e não promete prazo: %s', (t) => {
    const f = filtrarSaida(t)
    expect(f.alterado).toBe(false)
    expect(f.ocorrencias.filter((o) => o.acao !== 'registrado')).toEqual([])
    expect(verificarNumerosNaResposta(t, new Set())).toEqual([])
    expect(ajustarMensagemHandoff(t, { semNumeros: true, anexarRetomada: false }).ocorrencias).toEqual([])
  })
  it('o de fora do expediente fala do próximo horário', () => {
    expect(TEXTO_AVISO_ESPERA_FORA).toContain('no próximo horário de atendimento')
    expect(falaDoProximoHorario(TEXTO_AVISO_ESPERA_FORA)).toBe(true)
    expect(falaDoProximoHorario(COMPLEMENTO_AVISO_FORA)).toBe(true)
    expect(falaDoProximoHorario(TEXTO_AVISO_ESPERA)).toBe(false)
  })
  it('renderiza placeholders do playbook', () => {
    expect(renderizarAvisoEspera('Oi {nome}, aqui é {assistente} da {empresa}.', { nome: 'Ana Maria', assistente: 'Bia', empresa: 'Loja X' }))
      .toBe('Oi Ana, aqui é Bia da Loja X.')
    expect(renderizarAvisoEspera('Oi {nome}, tudo certo.', { nome: null })).toBe('Oi, tudo certo.')
  })
})

describe('corpoSlaConfig', () => {
  it('aceita o padrão', () => { expect(corpoSlaConfig.safeParse(SLA_PADRAO).success).toBe(true) })
  it.each([
    [{ slaMinutos: 4, reatribuicaoMinutos: 60, avisoEspera: true }, 'slaMinutos'],
    [{ slaMinutos: 30, reatribuicaoMinutos: 30, avisoEspera: true }, 'reatribuicaoMinutos'],
    [{ slaMinutos: 30, reatribuicaoMinutos: 2000, avisoEspera: true }, 'reatribuicaoMinutos'],
    [{ slaMinutos: 30.5, reatribuicaoMinutos: 60, avisoEspera: true }, 'slaMinutos'],
  ])('recusa %j (campo %s)', (c, campo) => {
    const r = corpoSlaConfig.safeParse(c)
    expect(r.success).toBe(false)
    expect(r.error!.issues.map((i) => i.path[0])).toContain(campo)
  })
  it('recusa campo desconhecido (strict)', () => {
    expect(corpoSlaConfig.safeParse({ ...SLA_PADRAO, extra: 1 }).success).toBe(false)
  })
})

describe('duracaoCurta', () => {
  it.each([[0, '0 min'], [59_999, '0 min'], [12 * 60_000, '12 min'], [65 * 60_000, '1 h 05'], [(26 * 60 + 3) * 60_000, '1 d 2 h']])('%i ms → %s', (ms, s) => {
    expect(duracaoCurta(ms)).toBe(s)
  })
})
