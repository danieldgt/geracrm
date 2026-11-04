import { describe, expect, it } from 'vitest'
import { emailValido, errosDaRedefinicao, errosDoEmail, resultadoDaRecuperacao } from './login.regras.js'

describe('esqueci a senha — regras puras', () => {
  it('e-mail: formato mínimo', () => {
    expect(emailValido(' ana@empresa.com ')).toBe(true)
    expect(emailValido('ana')).toBe(false)
    expect(errosDoEmail('')).toHaveProperty('usuario')
    expect(errosDoEmail('ana@empresa.com')).toEqual({})
  })

  it('redefinição: código numérico, senha mínima e confirmação igual', () => {
    expect(errosDaRedefinicao('abc', 'curta', 'outra')).toEqual({
      codigo: expect.any(String), novaSenha: expect.any(String), confirmacao: expect.any(String),
    })
    expect(errosDaRedefinicao('123456', 'Nova#12345', 'Nova#12345')).toEqual({})
  })

  it('resultado: sucesso, erro tipificado com campo, limite e rede caída', () => {
    expect(resultadoDaRecuperacao(200, { mensagem: 'Se o e-mail estiver cadastrado…' }))
      .toEqual({ tipo: 'ok', mensagem: 'Se o e-mail estiver cadastrado…' })
    expect(resultadoDaRecuperacao(422, { erro: 'auth.senha_invalida', mensagem: 'fraca', campos: { novaSenha: 'fraca' } }))
      .toEqual({ tipo: 'erro', mensagem: 'fraca', campos: { novaSenha: 'fraca' } })
    expect(resultadoDaRecuperacao(429, {}).tipo).toBe('erro')
    expect(resultadoDaRecuperacao(0, {})).toMatchObject({ tipo: 'erro', mensagem: expect.stringContaining('conexão') })
  })

  it('a resposta de sucesso não muda entre e-mail existente e inexistente (mesma mensagem do servidor)', () => {
    const corpo = { mensagem: 'Se o e-mail estiver cadastrado, enviamos um código para ele.' }
    expect(resultadoDaRecuperacao(200, corpo)).toEqual(resultadoDaRecuperacao(200, { ...corpo }))
  })
})
