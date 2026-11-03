import { describe, it, expect } from 'vitest'
import { validarEmpresa, telefoneValido } from './empresa-config.js'

const CNPJ_OK = '11222333000181'

describe('validarEmpresa', () => {
  it('só valida e devolve os campos presentes', () => {
    expect(validarEmpresa({ nome: '  Loja  ' })).toEqual({ ok: true, valores: { nome: 'Loja' } })
  })
  it('CNPJ: normaliza para dígitos, recusa dígito errado, vazio limpa', () => {
    expect(validarEmpresa({ cnpj: '11.222.333/0001-81' })).toEqual({ ok: true, valores: { cnpj: CNPJ_OK } })
    expect(validarEmpresa({ cnpj: '11222333000182' })).toMatchObject({ ok: false, campos: { cnpj: expect.any(String) } })
    expect(validarEmpresa({ cnpj: '' })).toEqual({ ok: true, valores: { cnpj: null } })
  })
  it('e-mail, site https, telefone', () => {
    const r = validarEmpresa({ email: 'a', dpoEmail: 'x@y', site: 'http://x.com', telefone: '123', whatsapp: '(11) 91234-5678' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(Object.keys(r.campos).sort()).toEqual(['dpoEmail', 'email', 'site', 'telefone'])
    expect(validarEmpresa({ whatsapp: '(11) 91234-5678', site: 'https://x.com.br' })).toEqual({
      ok: true, valores: { whatsapp: '11912345678', site: 'https://x.com.br' },
    })
    expect(telefoneValido('+55 11 91234-5678')).toBe(true)
  })
  it('retenção 6 a 120 inteiro', () => {
    for (const n of [5, 121, 12.5, '12']) expect(validarEmpresa({ retencaoMeses: n }).ok).toBe(false)
    expect(validarEmpresa({ retencaoMeses: 6 }).ok).toBe(true)
    expect(validarEmpresa({ retencaoMeses: 120 }).ok).toBe(true)
  })
  it('endereço: erro por subcampo; tudo vazio vira null', () => {
    expect(validarEmpresa({ endereco: { cep: '123', uf: 'XX' } })).toMatchObject({
      ok: false, campos: { 'endereco.cep': expect.any(String), 'endereco.uf': expect.any(String) },
    })
    expect(validarEmpresa({ endereco: { cep: '', cidade: ' ' } })).toEqual({ ok: true, valores: { endereco: null } })
    expect(validarEmpresa({ endereco: { cep: '01310-100', cidade: 'São Paulo', uf: 'sp' } })).toMatchObject({
      ok: true, valores: { endereco: { cep: '01310100', uf: 'SP', cidade: 'São Paulo' } },
    })
  })
  it('fuso usa o verificador injetado; booleano estrito; nome vazio recusa', () => {
    expect(validarEmpresa({ fuso: 'Marte/X' }, () => false).ok).toBe(false)
    expect(validarEmpresa({ exigirConsentimentoWhatsapp: 'sim' }).ok).toBe(false)
    expect(validarEmpresa({ nome: ' ' }).ok).toBe(false)
  })
})
