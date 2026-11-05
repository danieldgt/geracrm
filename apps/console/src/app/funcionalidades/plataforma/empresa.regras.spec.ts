import { describe, it, expect } from 'vitest'
import {
  corpoDaEmpresa, corpoDaLgpd, errosDoCorpo, errosDoServidor, formDaEmpresa, formDaLgpd, somenteLeitura,
  type EmpresaLida,
} from './empresa.regras.js'

const EMPRESA: EmpresaLida = {
  nome: 'Loja', fuso: 'America/Sao_Paulo', plano: 'pro', cnpj: '11222333000181', telefone: '1133334444', whatsapp: null,
  email: null, site: null, endereco: { cep: '01310100', logradouro: 'Av. Paulista', numero: '1', complemento: '', bairro: 'Bela Vista', cidade: 'São Paulo', uf: 'SP' },
  dpoNome: null, dpoEmail: 'dpo@loja.test', retencaoMeses: 24, textoConsentimento: null, exigirConsentimentoWhatsapp: true,
}

describe('Empresa: formulário e payload', () => {
  it('a API vira formulário com máscara e o formulário volta como dígitos', () => {
    const f = formDaEmpresa(EMPRESA)
    expect(f).toMatchObject({ cnpj: '11.222.333/0001-81', telefone: '(11) 3333-4444', cep: '01310-100', whatsapp: '', email: '' })
    expect(corpoDaEmpresa(f)).toMatchObject({
      cnpj: '11222333000181', telefone: '1133334444', whatsapp: '', endereco: { cep: '01310100', uf: 'SP' },
    })
  })

  it('o corpo montado de dados válidos não tem erro; CNPJ errado e e-mail ruim apontam o campo', () => {
    expect(errosDoCorpo(corpoDaEmpresa(formDaEmpresa(EMPRESA)))).toEqual({})
    const f = { ...formDaEmpresa(EMPRESA), cnpj: '11.222.333/0001-82', email: 'sem-arroba', cep: '123' }
    expect(Object.keys(errosDoCorpo(corpoDaEmpresa(f))).sort()).toEqual(['cnpj', 'email', 'endereco.cep'])
  })

  it('campos opcionais vazios são válidos (limpam)', () => {
    const f = { ...formDaEmpresa(EMPRESA), cnpj: '', telefone: '', cep: '', logradouro: '', numero: '', bairro: '', cidade: '', uf: '' }
    expect(errosDoCorpo(corpoDaEmpresa(f))).toEqual({})
  })
})

describe('LGPD: formulário e payload', () => {
  it('retenção digitada vira inteiro; fora de 6–120 ou não numérica é recusada', () => {
    const f = formDaLgpd(EMPRESA)
    expect(corpoDaLgpd(f)).toMatchObject({ retencaoMeses: 24, dpoEmail: 'dpo@loja.test', exigirConsentimentoWhatsapp: true })
    for (const ruim of ['5', '121', '12,5', '', 'abc']) {
      expect(errosDoCorpo(corpoDaLgpd({ ...f, retencaoMeses: ruim }))).toHaveProperty('retencaoMeses')
    }
    expect(errosDoCorpo(corpoDaLgpd({ ...f, retencaoMeses: '6' }))).toEqual({})
    expect(errosDoCorpo(corpoDaLgpd({ ...f, retencaoMeses: '120' }))).toEqual({})
  })

  it('e-mail do DPO inválido é recusado', () => {
    expect(errosDoCorpo(corpoDaLgpd({ ...formDaLgpd(EMPRESA), dpoEmail: 'dpo@' }))).toHaveProperty('dpoEmail')
  })
})

describe('Erro do servidor e papel', () => {
  it('só o 422 com campos vira erro por campo', () => {
    expect(errosDoServidor({ status: 422, error: { erro: 'validacao', campos: { cnpj: 'CNPJ inválido.' } } })).toEqual({ cnpj: 'CNPJ inválido.' })
    expect(errosDoServidor({ status: 422, error: {} })).toBeNull()
    expect(errosDoServidor({ status: 403, error: { campos: { a: 'b' } } })).toBeNull()
    expect(errosDoServidor(new Error('x'))).toBeNull()
  })

  it('só admin edita; sem resposta do papel fica em leitura', () => {
    expect(somenteLeitura(true)).toBe(false)
    expect(somenteLeitura(false)).toBe(true)
    expect(somenteLeitura(null)).toBe(true)
  })
})
