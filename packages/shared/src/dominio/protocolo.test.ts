import { describe, it, expect } from 'vitest'
import { formatarProtocolo, parsearProtocolo } from './protocolo.js'

describe('protocolo', () => {
  it('formata com zero-padding de 6', () => {
    expect(formatarProtocolo(318)).toBe('#000318')
    expect(formatarProtocolo(1)).toBe('#000001')
    expect(formatarProtocolo(1234567)).toBe('#1234567')
  })

  it('⚠️ busca aceita com/sem # e com/sem zeros — a identidade é o inteiro', () => {
    expect(parsearProtocolo('#000318')).toBe(318)
    expect(parsearProtocolo('318')).toBe(318)
    expect(parsearProtocolo('  #318 ')).toBe(318)
    expect(parsearProtocolo('000318')).toBe(318)
  })

  it('rejeita não-número', () => {
    expect(parsearProtocolo('abc')).toBeNull()
    expect(parsearProtocolo('')).toBeNull()
    expect(parsearProtocolo('0')).toBeNull()
  })
})
