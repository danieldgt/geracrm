import { describe, it, expect } from 'vitest'
import { dadosMinimosDoGanho, type DadosDoGanho } from './ganho.js'

const completo: DadosDoGanho = {
  cnpj: '11.222.333/0001-81', razaoSocial: 'Acme Ltda', nomeFantasia: 'Acme',
  cep: '01310-100', logradouro: 'Av. Paulista', numero: '1000', bairro: 'Bela Vista', cidade: 'São Paulo', uf: 'SP',
}

describe('dadosMinimosDoGanho', () => {
  it('completo → ok (complemento é opcional)', () => {
    expect(dadosMinimosDoGanho(completo)).toEqual({ ok: true })
  })
  it('vazio → aponta os nove campos', () => {
    const r = dadosMinimosDoGanho({})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(Object.keys(r.faltando).sort()).toEqual(
      ['bairro', 'cep', 'cidade', 'cnpj', 'logradouro', 'nomeFantasia', 'numero', 'razaoSocial', 'uf'])
  })
  it.each([
    ['cnpj', null, 'Informe o CNPJ'],
    ['cnpj', '11.222.333/0001-82', 'CNPJ inválido'],
    ['razaoSocial', '  ', 'Informe a razão social'],
    ['nomeFantasia', '', 'Informe o nome fantasia'],
    ['cep', null, 'Informe o CEP'],
    ['cep', '123', 'CEP inválido'],
    ['logradouro', undefined, 'Informe o logradouro'],
    ['numero', '', 'Informe o número'],
    ['bairro', null, 'Informe o bairro'],
    ['cidade', '', 'Informe a cidade'],
    ['uf', null, 'Informe a UF'],
    ['uf', 'SPP', 'UF inválida'],
  ] as const)('falta só %s=%s → %s', (campo, valor, msg) => {
    const r = dadosMinimosDoGanho({ ...completo, [campo]: valor })
    expect(r).toEqual({ ok: false, faltando: { [campo]: msg } })
  })
})
