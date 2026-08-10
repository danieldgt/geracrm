import { describe, it, expect } from 'vitest'
import { validarCpf, validarCnpj, normalizarDocumento } from './documento.js'

describe('validação de documento (dígito verificador)', () => {
  it('CPF válido e inválido', () => {
    expect(validarCpf('529.982.247-25')).toBe(true) // válido conhecido
    expect(validarCpf('52998224724')).toBe(false)    // dígito errado
    expect(validarCpf('11111111111')).toBe(false)    // todos iguais
    expect(validarCpf('123')).toBe(false)
  })
  it('CNPJ válido e inválido', () => {
    expect(validarCnpj('11.222.333/0001-81')).toBe(true) // válido conhecido
    expect(validarCnpj('11222333000180')).toBe(false)    // dígito errado
    expect(validarCnpj('00000000000000')).toBe(false)
  })
  it('normalizarDocumento devolve só dígitos ou null', () => {
    expect(normalizarDocumento('cpf', '529.982.247-25')).toBe('52998224725')
    expect(normalizarDocumento('cnpj', '11.222.333/0001-81')).toBe('11222333000181')
    expect(normalizarDocumento('cpf', '000')).toBeNull()
  })
})
