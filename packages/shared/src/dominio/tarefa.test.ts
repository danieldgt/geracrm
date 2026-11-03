import { describe, it, expect } from 'vitest'
import { semProximoPasso, ehTipoTarefa } from './tarefa.js'

describe('semProximoPasso', () => {
  it('sem tarefa e sem evento → true', () => {
    expect(semProximoPasso({ tarefasAbertasFuturas: 0, eventosFuturos: 0, moduloAgendaAtivo: true })).toBe(true)
  })
  it('com tarefa aberta futura → false', () => {
    expect(semProximoPasso({ tarefasAbertasFuturas: 1, eventosFuturos: 0, moduloAgendaAtivo: false })).toBe(false)
  })
  it('evento conta só com a agenda ativa', () => {
    expect(semProximoPasso({ tarefasAbertasFuturas: 0, eventosFuturos: 2, moduloAgendaAtivo: true })).toBe(false)
    expect(semProximoPasso({ tarefasAbertasFuturas: 0, eventosFuturos: 2, moduloAgendaAtivo: false })).toBe(true)
  })
  it('valores negativos não contam', () => {
    expect(semProximoPasso({ tarefasAbertasFuturas: -1, eventosFuturos: 0, moduloAgendaAtivo: true })).toBe(true)
  })
})

describe('ehTipoTarefa', () => {
  it('aceita só os tipos conhecidos', () => {
    expect(ehTipoTarefa('ligacao')).toBe(true)
    expect(ehTipoTarefa('outro')).toBe(true)
    expect(ehTipoTarefa('fax')).toBe(false)
    expect(ehTipoTarefa(null)).toBe(false)
  })
})
