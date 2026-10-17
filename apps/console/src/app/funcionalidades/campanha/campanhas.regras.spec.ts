import { describe, it, expect } from 'vitest'
import { avisoDePausa } from './campanhas.regras.js'

describe('avisoDePausa — campanha segurada por suspensão das ativas (P11)', () => {
  it('sem suspensão, sem aviso', () => {
    expect(avisoDePausa(null)).toBeNull()
    expect(avisoDePausa(undefined)).toBeNull()
  })

  it('queda de qualidade: "pausada por qualidade do número", retoma sozinha', () => {
    const a = avisoDePausa({ desde: '2026-10-01T10:00:00Z', motivo: 'qualidade:FLAGGED:RED' })
    expect(a?.titulo).toBe('Pausada por qualidade do número')
    expect(a?.detalhe).toMatch(/retoma sozinha/)
  })

  it('motivo ausente vale como qualidade', () => {
    expect(avisoDePausa({ desde: '2026-10-01T10:00:00Z', motivo: null })?.titulo).toBe('Pausada por qualidade do número')
  })

  it('conta restrita: nomeia a conta e diz quem libera', () => {
    const a = avisoDePausa({ desde: '2026-10-01T10:00:00Z', motivo: 'conta:ACCOUNT_RESTRICTION' })
    expect(a?.titulo).toMatch(/conta do número/)
    expect(a?.detalhe).toMatch(/libere/)
  })
})
