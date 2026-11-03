import { describe, it, expect } from 'vitest'
import {
  formDaFicha, formVazio, mapearErros, mensagemConsulta, montarPayload, podeConsultarCep, podeConsultarCnpj,
  preencherEndereco, preencherPelaEmpresa, validarLocal, type EmpresaConsulta,
} from './contato-form.regras.js'

const empresa: EmpresaConsulta = {
  razaoSocial: 'Saturno e Alves LTDA', nomeFantasia: 'Saturno Modas', situacao: 'ATIVA',
  endereco: { cep: '50000000', logradouro: 'Rua A', numero: '10', complemento: null, bairro: 'Centro', cidade: 'Recife', uf: 'PE' },
}

describe('montarPayload', () => {
  it('dado formulário em branco, então campos vazios viram null e nada de string vazia', () => {
    const p = montarPayload({ ...formVazio(), nome: '  Maria ', telefone: '81988887777' })
    expect(p).toMatchObject({ nome: 'Maria', telefone: '81988887777', razaoSocial: null, email: null, documento: null,
      modalidade: null, prioridade: null, valorEstimadoCentavos: null, observacoes: null })
    expect(p.endereco).toEqual({ cep: null, logradouro: null, numero: null, complemento: null, bairro: null, cidade: null, uf: null })
  })

  it('dado campos preenchidos, então mantém dinheiro em centavos e UF em maiúsculas', () => {
    const p = montarPayload({ ...formVazio(), nome: 'A', telefone: '1', uf: 'pe', valorEstimadoCentavos: 150000,
      prioridade: 'alta', whatsapp: false })
    expect(p.valorEstimadoCentavos).toBe(150000)
    expect(p.endereco.uf).toBe('PE')
    expect(p.prioridade).toBe('alta')
    expect(p.whatsapp).toBe(false)
  })
})

describe('validarLocal', () => {
  it('exige só nome e telefone', () => {
    expect(validarLocal(formVazio())).toEqual({ nome: 'Informe o nome', telefone: 'Informe o telefone' })
    expect(validarLocal({ ...formVazio(), nome: 'A', telefone: '81988887777' })).toEqual({})
  })
})

describe('mapearErros (422 por campo)', () => {
  it('dado 422 de validação, então devolve cada mensagem no seu campo', () => {
    const r = mapearErros({ erro: 'validacao', mensagem: 'x', campos: { documento: 'CNPJ inválido', email: 'E-mail inválido', cep: 'CEP inválido' } })
    expect(r.campos).toEqual({ documento: 'CNPJ inválido', email: 'E-mail inválido', cep: 'CEP inválido' })
    expect(r.geral).toBeNull()
  })

  it('dado campo que a tela não conhece, então a mensagem vai para o erro geral (não some)', () => {
    const r = mapearErros({ erro: 'validacao', campos: { nome: 'Informe o nome', corpo: 'Corpo inválido' } })
    expect(r.campos).toEqual({ nome: 'Informe o nome' })
    expect(r.geral).toBe('Corpo inválido')
  })

  it('dado erro que não é de validação ou corpo ausente, então nada por campo', () => {
    expect(mapearErros({ erro: 'erro.interno' })).toEqual({ campos: {}, geral: null })
    expect(mapearErros(null)).toEqual({ campos: {}, geral: null })
    expect(mapearErros('texto')).toEqual({ campos: {}, geral: null })
  })
})

describe('preencher pelas consultas', () => {
  it('CNPJ: preenche razão social, fantasia e endereço; sugere o nome só se vazio', () => {
    const v = preencherPelaEmpresa(formVazio(), empresa)
    expect(v).toMatchObject({ razaoSocial: 'Saturno e Alves LTDA', nomeFantasia: 'Saturno Modas', nome: 'Saturno Modas',
      cep: '50000000', logradouro: 'Rua A', numero: '10', bairro: 'Centro', cidade: 'Recife', uf: 'PE' })
  })

  it('CNPJ: não troca o nome que o usuário já digitou', () => {
    expect(preencherPelaEmpresa({ ...formVazio(), nome: 'Saturno' }, empresa).nome).toBe('Saturno')
  })

  it('CNPJ: o que a consulta não trouxe fica como estava', () => {
    const v = preencherPelaEmpresa({ ...formVazio(), complemento: 'Sala 2' }, empresa)
    expect(v.complemento).toBe('Sala 2')
  })

  it('CEP: preenche rua/bairro/cidade/UF e preserva número e complemento digitados', () => {
    const v = preencherEndereco({ ...formVazio(), numero: '99', complemento: 'Apto 1' },
      { cep: '50000000', logradouro: 'Rua A', numero: null, complemento: null, bairro: 'Centro', cidade: 'Recife', uf: 'PE' })
    expect(v).toMatchObject({ logradouro: 'Rua A', cidade: 'Recife', uf: 'PE', numero: '99', complemento: 'Apto 1' })
  })

  it('CEP genérico (sem logradouro) não apaga a rua já digitada', () => {
    const v = preencherEndereco({ ...formVazio(), logradouro: 'Rua do Cliente' },
      { cep: '50000000', logradouro: null, numero: null, complemento: null, bairro: null, cidade: 'Recife', uf: 'PE' })
    expect(v.logradouro).toBe('Rua do Cliente')
    expect(v.cidade).toBe('Recife')
  })
})

describe('consultas', () => {
  it('só consulta com CEP de 8 dígitos e CNPJ de 14 (CPF não tem consulta)', () => {
    expect(podeConsultarCep('50000-000')).toBe(true)
    expect(podeConsultarCep('5000')).toBe(false)
    expect(podeConsultarCnpj('11.222.333/0001-81')).toBe(true)
    expect(podeConsultarCnpj('11222333000')).toBe(false)
  })

  it('mensagem libera o preenchimento manual em qualquer falha', () => {
    expect(mensagemConsulta('consulta.indisponivel', 'CNPJ')).toContain('manualmente')
    expect(mensagemConsulta('consulta.nao_encontrado', 'CEP')).toBe('CEP não encontrado. Preencha manualmente.')
    expect(mensagemConsulta(null, 'CEP')).toContain('manualmente')
  })
})

describe('formDaFicha', () => {
  it('usa o telefone principal, o documento fiscal e o endereço da ficha', () => {
    const v = formDaFicha({
      nome: 'Saturno', razaoSocial: 'S LTDA', nomeFantasia: null, email: 'a@b.com', modalidade: 'atacado',
      prioridade: 'alta', temperatura: null, valorEstimadoCentavos: 5000, observacoes: null,
      telefones: [{ e164: '+5581911112222', principal: false, whatsapp: false }, { e164: '+5581933334444', principal: true, whatsapp: true }],
      documentos: [{ tipo: 'cnpj', numero: '1', fiscal: false }, { tipo: 'cnpj', numero: '11222333000181', fiscal: true }],
      endereco: { cep: '50000000', logradouro: 'Rua A', numero: null, complemento: null, bairro: null, cidade: 'Recife', uf: 'PE' },
    })
    expect(v).toMatchObject({ telefone: '+5581933334444', whatsapp: true, documento: '11222333000181', razaoSocial: 'S LTDA',
      nomeFantasia: '', cidade: 'Recife', prioridade: 'alta', valorEstimadoCentavos: 5000, numero: '' })
  })

  it('ficha sem telefone, documento e endereço vira formulário vazio nesses blocos', () => {
    const v = formDaFicha({
      nome: 'X', razaoSocial: null, nomeFantasia: null, email: null, modalidade: null, prioridade: null, temperatura: null,
      valorEstimadoCentavos: null, observacoes: null, telefones: [], documentos: [], endereco: null,
    })
    expect(v).toMatchObject({ nome: 'X', telefone: '', documento: '', cep: '', whatsapp: true })
  })
})
