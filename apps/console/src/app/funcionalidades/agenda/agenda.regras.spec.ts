import { describe, it, expect } from 'vitest'
import type { EventoAgenda } from '@geracrm/shared'
import {
  acoesDoStatus, cabeNoDia, conflitoLocal, eventosPorDia, formVazio, janelaDaGrade, montarGradeMes, mudarMes,
  payloadEvento, rotuloMes, validarEvento, type FormEvento,
} from './agenda.regras.js'

const ev = (id: string, inicio: string, fim: string, extra: Partial<EventoAgenda> = {}): EventoAgenda => ({
  id, titulo: id, descricao: null, contatoId: null, contato: null, responsavelId: 'u1', responsavel: null,
  inicio: new Date(inicio).toISOString(), fim: new Date(fim).toISOString(), tipo: 'reuniao', modalidade: 'presencial',
  local: null, link: null, lembreteMin: null, cor: 'acao', status: 'agendado', versao: 1, ...extra,
})

describe('montarGradeMes', () => {
  it('novembro/2026: começa domingo 1º, 5 semanas, termina sábado 5/12', () => {
    const g = montarGradeMes({ ano: 2026, mes: 10 }, '2026-11-03')
    expect(g).toHaveLength(5)
    expect(g.every((s) => s.length === 7)).toBe(true)
    expect(g[0]![0]).toMatchObject({ iso: '2026-11-01', dia: 1, doMes: true })
    expect(g[4]![6]).toMatchObject({ iso: '2026-12-05', doMes: false })
    expect(g.flat().filter((d) => d.hoje).map((d) => d.iso)).toEqual(['2026-11-03'])
  })
  it('fevereiro/2026 cabe em 4 semanas exatas (sem dias de fora)', () => {
    const g = montarGradeMes({ ano: 2026, mes: 1 }, '2026-02-15')
    expect(g).toHaveLength(4)
    expect(g.flat().every((d) => d.doMes)).toBe(true)
  })
  it('agosto/2026 precisa de 6 semanas; o rabo da semana anterior vem marcado como de fora', () => {
    const g = montarGradeMes({ ano: 2026, mes: 7 }, '2026-01-01')
    expect(g).toHaveLength(6)
    expect(g[0]![0]).toMatchObject({ iso: '2026-07-26', doMes: false })
    expect(g[0]![6]).toMatchObject({ iso: '2026-08-01', doMes: true })
    expect(g.flat().some((d) => d.hoje)).toBe(false)
  })
  it('fronteira de ano: dezembro termina em janeiro; a janela pedida à API tem no máximo 42 dias', () => {
    const g = montarGradeMes({ ano: 2026, mes: 11 }, '2026-12-25')
    expect(g.flat().at(-1)!.iso).toBe('2027-01-02')
    for (const m of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
      const j = janelaDaGrade(montarGradeMes({ ano: 2026, mes: m }, ''))
      const dias = (Date.parse(j.ate) - Date.parse(j.de)) / 86_400_000 + 1
      expect(dias).toBeLessThanOrEqual(42)
      expect(dias % 7).toBe(0)
    }
  })
})

describe('mudarMes / rotuloMes', () => {
  it('vira o ano nos dois sentidos', () => {
    expect(mudarMes({ ano: 2026, mes: 11 }, 1)).toEqual({ ano: 2027, mes: 0 })
    expect(mudarMes({ ano: 2026, mes: 0 }, -1)).toEqual({ ano: 2025, mes: 11 })
    expect(mudarMes({ ano: 2026, mes: 5 }, 0)).toEqual({ ano: 2026, mes: 5 })
    expect(rotuloMes(2026, 10)).toBe('Novembro de 2026')
  })
})

describe('eventosPorDia e "+N"', () => {
  it('agrupa por dia local, ordena por início e espalha evento de vários dias', () => {
    const m = eventosPorDia([
      ev('b', '2026-11-03T15:00', '2026-11-03T16:00'),
      ev('a', '2026-11-03T09:00', '2026-11-03T10:00'),
      ev('longo', '2026-11-04T22:00', '2026-11-05T02:00'),
    ])
    expect(m.get('2026-11-03')!.map((e) => e.id)).toEqual(['a', 'b'])
    expect(m.get('2026-11-04')!.map((e) => e.id)).toEqual(['longo'])
    expect(m.get('2026-11-05')!.map((e) => e.id)).toEqual(['longo'])
  })
  it('fim exatamente à meia-noite não vaza para o dia seguinte', () => {
    const m = eventosPorDia([ev('x', '2026-11-03T23:00', '2026-11-04T00:00')])
    expect([...m.keys()]).toEqual(['2026-11-03'])
  })
  it('cabeNoDia: cabendo mostra todos; senão o último slot vira "+N"', () => {
    expect(cabeNoDia([1, 2, 3], 3)).toEqual({ visiveis: [1, 2, 3], restantes: 0 })
    expect(cabeNoDia([1, 2, 3, 4, 5], 3)).toEqual({ visiveis: [1, 2], restantes: 3 })
    expect(cabeNoDia([], 3)).toEqual({ visiveis: [], restantes: 0 })
  })
})

describe('conflitoLocal', () => {
  const existentes = [
    ev('e1', '2026-11-03T10:00', '2026-11-03T11:00'),
    ev('e2', '2026-11-03T13:00', '2026-11-03T14:00', { status: 'cancelado' }),
    ev('e3', '2026-11-03T15:00', '2026-11-03T16:00', { responsavelId: 'u2' }),
  ]
  const cand = (h1: string, h2: string, extra = {}) => ({
    inicio: new Date(`2026-11-03T${h1}`).toISOString(), fim: new Date(`2026-11-03T${h2}`).toISOString(), responsavelId: 'u1', ...extra,
  })
  it('detecta sobreposição do mesmo responsável; encostar não conflita', () => {
    expect(conflitoLocal(existentes, cand('10:30', '11:30'))?.id).toBe('e1')
    expect(conflitoLocal(existentes, cand('11:00', '12:00'))).toBeNull()
  })
  it('ignora cancelado, outro responsável e o próprio evento editado', () => {
    expect(conflitoLocal(existentes, cand('13:00', '14:00'))).toBeNull()
    expect(conflitoLocal(existentes, cand('15:00', '16:00'))).toBeNull()
    expect(conflitoLocal(existentes, cand('10:00', '11:00', { ignorarId: 'e1' }))).toBeNull()
  })
})

describe('formulário', () => {
  const ok: FormEvento = { ...formVazio('2026-11-10'), titulo: '  Visita  ', contatoId: 'c1', lembrete: '30' }
  it('valida título, data, horário e link', () => {
    expect(validarEvento(ok)).toEqual({})
    expect(validarEvento({ ...ok, titulo: ' ' }).titulo).toBeTruthy()
    expect(validarEvento({ ...ok, titulo: 'x'.repeat(121) }).titulo).toBeTruthy()
    expect(validarEvento({ ...ok, data: '' }).data).toBeTruthy()
    expect(validarEvento({ ...ok, inicio: '10:00', fim: '09:00' }).fim).toBeTruthy()
    expect(validarEvento({ ...ok, link: 'meet.exemplo' }).link).toBeTruthy()
  })
  it('monta o corpo: vazios viram null, lembrete vira número, versão só quando editando', () => {
    const p = payloadEvento(ok)!
    expect(p).toMatchObject({ titulo: 'Visita', contatoId: 'c1', descricao: null, local: null, link: null, lembreteMin: 30, cor: 'acao' })
    expect(p['versao']).toBeUndefined()
    expect(payloadEvento({ ...ok, lembrete: '' }, 3)).toMatchObject({ lembreteMin: null, versao: 3 })
    expect(payloadEvento({ ...ok, data: '' })).toBeNull()
  })
  it('ações por status: só o agendado oferece mudar', () => {
    expect(acoesDoStatus('agendado')).toEqual(['realizado', 'nao_compareceu', 'cancelado'])
    expect(acoesDoStatus('realizado')).toEqual([])
  })
})
