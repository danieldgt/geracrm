import '@angular/compiler'
import { describe, it, expect } from 'vitest'
import { HttpErrorResponse } from '@angular/common/http'
import { errosDeCampos } from './erro-http.js'

const e422 = (corpo: object): HttpErrorResponse => new HttpErrorResponse({ status: 422, error: corpo })

describe('errosDeCampos (422 vai para o campo)', () => {
  it('campo conhecido vai para o campo e não há mensagem geral', () => {
    const r = errosDeCampos(e422({ erro: 'validacao', campos: { nome: 'Informe o nome', outro: 'x' } }), ['nome'], 'falhou')
    expect(r).toEqual({ campos: { nome: 'Informe o nome' }, geral: null })
  })
  it('sem campo conhecido, a mensagem da API vira o erro geral (inline)', () => {
    const r = errosDeCampos(e422({ erro: 'x', mensagem: 'Nome já existe.', campos: { outro: 'y' } }), ['nome'], 'falhou')
    expect(r).toEqual({ campos: {}, geral: 'Nome já existe.' })
  })
  it('erro que não é HTTP cai no padrão', () => {
    expect(errosDeCampos(new Error('x'), ['nome'], 'Não foi possível salvar.')).toEqual({ campos: {}, geral: 'Não foi possível salvar.' })
  })
})
