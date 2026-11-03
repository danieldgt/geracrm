import { describe, it, expect } from 'vitest'
import type { CardsCockpit, GrupoCockpit } from '@geracrm/shared'
import {
  DEBOUNCE_RECARGA_MS, FALLBACK_RECARGA_MS, acoesDoItem, cartoesDoCockpit, colunasDosGrupos, criarRecargaAgendada,
  linhasDosGrupos, piorFaixa, queryDosItens, resumoPorFaixa, textoAtualizado, textoHa, tomDoAguardando, type Relogio,
} from './cockpit.regras.js'

const cards = (o: Partial<CardsCockpit> = {}): CardsCockpit => ({
  aguardandoHumano: { total: 5, porFaixa: { ok: 2, atencao: 1, estourado: 2 } },
  slaEstouradoHoje: 1, esquecidos: 4, reunioesHoje: 3, naoCompareceuHoje: 0, semProximoPasso: 2, ...o,
})
const grupo = (chave: string, o: Partial<GrupoCockpit> = {}): GrupoCockpit => ({
  chave, rotulo: chave, aguardandoHumano: 0, slaEstouradoHoje: 0, esquecidos: 0, reunioesHoje: 0, naoCompareceuHoje: 0, semProximoPasso: 0, ...o,
})

describe('faixas do aguardando humano', () => {
  it('a pior faixa manda no tom (estourado > atenção > no prazo) e zero fica neutro', () => {
    expect(piorFaixa({ ok: 3, atencao: 1, estourado: 0 })).toBe('atencao')
    expect(tomDoAguardando({ ok: 0, atencao: 0, estourado: 1 })).toBe('erro')
    expect(tomDoAguardando({ ok: 4, atencao: 0, estourado: 0 })).toBe('sucesso')
    expect(tomDoAguardando({ ok: 0, atencao: 0, estourado: 0 })).toBe('neutro')
  })
  it('o resumo diz a faixa por extenso (nunca cor sozinha)', () => {
    expect(resumoPorFaixa({ ok: 2, atencao: 1, estourado: 2 })).toBe('2 no prazo · 1 em atenção · 2 estourados')
    expect(resumoPorFaixa({ ok: 0, atencao: 0, estourado: 1 })).toBe('1 estourado')
    expect(resumoPorFaixa({ ok: 0, atencao: 0, estourado: 0 })).toBe('Ninguém esperando')
  })
})

describe('cards e grupos', () => {
  it('seis cards na ordem do contrato; zero não grita', () => {
    const c = cartoesDoCockpit(cards())
    expect(c.map((x) => x.chave)).toEqual(['aguardandoHumano', 'slaEstouradoHoje', 'esquecidos', 'reunioesHoje', 'naoCompareceuHoje', 'semProximoPasso'])
    expect(c[0]).toMatchObject({ valor: 5, tom: 'erro' })
    expect(c.find((x) => x.chave === 'naoCompareceuHoje')!.tom).toBe('neutro')
  })
  it('módulo agenda desligado (null): os dois cards somem', () => {
    const c = cartoesDoCockpit(cards({ reunioesHoje: null, naoCompareceuHoje: null }))
    expect(c.map((x) => x.chave)).toEqual(['aguardandoHumano', 'slaEstouradoHoje', 'esquecidos', 'semProximoPasso'])
    expect(colunasDosGrupos(c, 'Vendedor').map((x) => x.chave)).toEqual(['rotulo', 'aguardandoHumano', 'slaEstouradoHoje', 'esquecidos', 'semProximoPasso'])
  })
  it('linhas: grupo zerado some, total por linha, ordem da API preservada', () => {
    const c = cartoesDoCockpit(cards({ reunioesHoje: null, naoCompareceuHoje: null }))
    const l = linhasDosGrupos([
      grupo('a', { esquecidos: 2, semProximoPasso: 1 }), grupo('b'), grupo('sem', { aguardandoHumano: 1, reunioesHoje: null, naoCompareceuHoje: null }),
    ], c)
    expect(l.map((x) => x.chave)).toEqual(['a', 'sem'])
    expect(l[0]).toMatchObject({ total: 3, valores: { esquecidos: 2, semProximoPasso: 1, aguardandoHumano: 0 } })
    expect(l[0]!.valores).not.toHaveProperty('reunioesHoje')
  })
})

describe('itens', () => {
  it('ações: conversa abre no trilho, contato abre ficha e cria tarefa, evento abre o detalhe', () => {
    expect(acoesDoItem({ tipo: 'conversa', conversaId: 'c', contatoId: 'k' })).toEqual(['abrirConversa', 'abrirFicha', 'criarTarefa'])
    expect(acoesDoItem({ tipo: 'contato', conversaId: null, contatoId: 'k' })).toEqual(['abrirFicha', 'criarTarefa'])
    expect(acoesDoItem({ tipo: 'evento', conversaId: null, contatoId: null })).toEqual(['abrirEvento'])
  })
  it('"há quanto tempo" e "atualizado há"', () => {
    const agora = new Date('2026-11-03T15:00:00Z')
    expect(textoHa('2026-11-03T14:48:00Z', agora)).toBe('há 12 min')
    expect(textoHa('2026-11-03T12:55:00Z', agora)).toBe('há 2 h 05')
    expect(textoHa('2026-11-03T17:00:00Z', agora)).toBe('em 2 h 00')
    expect(textoHa('2026-11-03T14:59:40Z', agora)).toBe('agora')
    expect(textoAtualizado('2026-11-03T14:57:00Z', agora)).toBe('atualizado há 3 min')
    expect(textoAtualizado('2026-11-03T14:59:30Z', agora)).toBe('atualizado agora')
    expect(textoAtualizado(null, agora)).toBe('')
  })
  it('a query omite o vazio e só manda faixa no card de aguardando', () => {
    const base = { agrupar: 'vendedor', grupo: null, dias: 7, cursor: null }
    expect(queryDosItens({ ...base, card: 'esquecidos', faixa: 'estourado' })).toBe('card=esquecidos&agrupar=vendedor&dias=7')
    expect(queryDosItens({ ...base, card: 'aguardandoHumano', faixa: 'estourado', grupo: 'g1', cursor: 'abc' }))
      .toBe('card=aguardandoHumano&agrupar=vendedor&dias=7&grupo=g1&faixa=estourado&cursor=abc')
  })
})

/** Relógio de mentira: nada espera de verdade. */
function relogioFalso() {
  let agora = 0
  let n = 0
  const pend = new Map<number, { em: number; fn: () => void }>()
  const relogio: Relogio = {
    setTimeout: (fn, ms) => { pend.set(++n, { em: agora + ms, fn }); return n },
    clearTimeout: (id) => { pend.delete(id as number) },
  }
  const avancar = (ms: number): void => {
    const alvo = agora + ms
    for (;;) {
      const prox = [...pend.entries()].filter(([, t]) => t.em <= alvo).sort((a, b) => a[1].em - b[1].em)[0]
      if (!prox) break
      agora = prox[1].em
      pend.delete(prox[0])
      prox[1].fn()
    }
    agora = alvo
  }
  return { relogio, avancar, pendentes: () => pend.size }
}

describe('recarga agendada (debounce de 5 s + fallback de 2 min)', () => {
  it('uma rajada de eventos vira UMA recarga, 5 s depois do último', () => {
    const r = relogioFalso(); let n = 0
    const rec = criarRecargaAgendada(() => { n++; rec.recarregou() }, r.relogio)
    rec.acionar(); r.avancar(3_000); rec.acionar(); r.avancar(3_000); rec.acionar()
    r.avancar(DEBOUNCE_RECARGA_MS - 1)
    expect(n).toBe(0)
    r.avancar(1)
    expect(n).toBe(1)
    r.avancar(DEBOUNCE_RECARGA_MS * 3)
    expect(n).toBe(1)
  })
  it('sem evento algum, recarrega a cada 2 min (e rearma)', () => {
    const r = relogioFalso(); let n = 0
    const rec = criarRecargaAgendada(() => { n++; rec.recarregou() }, r.relogio)
    r.avancar(FALLBACK_RECARGA_MS - 1); expect(n).toBe(0)
    r.avancar(1); expect(n).toBe(1)
    r.avancar(FALLBACK_RECARGA_MS); expect(n).toBe(2)
  })
  it('recarregar por evento adia o fallback (não há polling por cima do tempo real)', () => {
    const r = relogioFalso(); let n = 0
    const rec = criarRecargaAgendada(() => { n++; rec.recarregou() }, r.relogio)
    r.avancar(100_000)
    rec.acionar(); r.avancar(DEBOUNCE_RECARGA_MS)
    expect(n).toBe(1)
    r.avancar(FALLBACK_RECARGA_MS - 1); expect(n).toBe(1)
    r.avancar(1); expect(n).toBe(2)
  })
  it('parar cancela tudo', () => {
    const r = relogioFalso(); let n = 0
    const rec = criarRecargaAgendada(() => { n++ }, r.relogio)
    rec.acionar(); rec.parar(); rec.acionar()
    r.avancar(FALLBACK_RECARGA_MS * 2)
    expect(n).toBe(0); expect(r.pendentes()).toBe(0)
  })
})
