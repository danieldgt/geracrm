import { describe, it, expect } from 'vitest'
import { previewMensagem } from './mensagem.js'

describe('prévia da mensagem na lista de conversas', () => {
  it('dado texto, então mostra o texto', () => {
    expect(previewMensagem('texto', { texto: 'oi' })).toBe('oi')
  })
  it('dado mensagem de sistema, então rótulo neutro — nunca "[sistema]"', () => {
    expect(previewMensagem('sistema', { texto: 'Agente transferiu: pedido humano.', automatica: 'agente_handoff' })).toBe('Aviso do sistema')
  })
  it('dado tipo desconhecido, então o tipo entre colchetes', () => {
    expect(previewMensagem('sticker', {})).toBe('[sticker]')
  })
})
