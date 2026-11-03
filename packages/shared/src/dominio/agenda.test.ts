import { describe, expect, it } from 'vitest'
import { ehLembreteEvento, ehStatusEvento, periodosSobrepoem } from './agenda.js'

describe('agenda (shared)', () => {
  it('valida vocabulário', () => {
    expect(ehLembreteEvento(15)).toBe(true)
    expect(ehLembreteEvento(10)).toBe(false)
    expect(ehStatusEvento('cancelado')).toBe(true)
    expect(ehStatusEvento('apagado')).toBe(false)
  })
  it('sobreposição: encostar não conflita', () => {
    const a = { inicio: '2026-11-03T10:00:00Z', fim: '2026-11-03T11:00:00Z' }
    expect(periodosSobrepoem(a, { inicio: '2026-11-03T11:00:00Z', fim: '2026-11-03T12:00:00Z' })).toBe(false)
    expect(periodosSobrepoem(a, { inicio: '2026-11-03T10:30:00Z', fim: '2026-11-03T12:00:00Z' })).toBe(true)
    expect(periodosSobrepoem(a, { inicio: '2026-11-03T09:00:00Z', fim: '2026-11-03T10:00:00Z' })).toBe(false)
  })
})
