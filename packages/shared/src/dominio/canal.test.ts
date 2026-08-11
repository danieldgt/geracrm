import { describe, it, expect } from 'vitest'
import { familiaCanal, rotuloCanal, riscoBanimentoCanal, type TipoCanal } from './canal.js'

describe('Identidade de canal', () => {
  it('dado os dois tipos de WhatsApp, então ambos usam a mesma família (mesmo logo)', () => {
    expect(familiaCanal('whatsapp_oficial')).toBe('whatsapp')
    expect(familiaCanal('whatsapp_nao_oficial')).toBe('whatsapp')
  })

  it('dado Instagram e TikTok, então cada um tem sua própria família', () => {
    expect(familiaCanal('instagram')).toBe('instagram')
    expect(familiaCanal('tiktok')).toBe('tiktok')
  })

  it('dado o WhatsApp não-oficial, então o rótulo deixa a natureza visível', () => {
    // ADR-021: a interface precisa distinguir oficial de não-oficial em texto,
    // porque o logo é o mesmo para os dois.
    expect(rotuloCanal('whatsapp_oficial')).toBe('WhatsApp')
    expect(rotuloCanal('whatsapp_nao_oficial')).toBe('WhatsApp (não-oficial)')
    expect(rotuloCanal('instagram')).toBe('Instagram')
    expect(rotuloCanal('tiktok')).toBe('TikTok')
  })

  it('dado apenas o não-oficial, então só ele carrega risco de banimento', () => {
    const tipos: TipoCanal[] = ['whatsapp_oficial', 'whatsapp_nao_oficial', 'instagram', 'tiktok']
    const comRisco = tipos.filter(riscoBanimentoCanal)
    expect(comRisco).toEqual(['whatsapp_nao_oficial'])
  })
})
