import { describe, it, expect } from 'vitest'
import {
  estadoOrigem, formDaFicha, formVazio, mapearErros, mensagemConsulta, montarPayload, opcoesOrigem, ordenarOrigens,
  podeConsultarCep, podeConsultarCnpj, preencherEndereco, preencherPelaEmpresa, validarLocal,
  type EmpresaConsulta, type OrigemLista,
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
      prioridade: 'alta', temperatura: null, origemId: null, valorEstimadoCentavos: 5000, observacoes: null,
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
      origemId: null, valorEstimadoCentavos: null, observacoes: null, telefones: [], documentos: [], endereco: null,
    })
    expect(v).toMatchObject({ nome: 'X', telefone: '', documento: '', cep: '', whatsapp: true })
  })
})

const origem = (parcial: Partial<OrigemLista> & { id: string }): OrigemLista => ({
  nome: parcial.id, ativa: true, ordem: 0, ...parcial,
})

describe('ordenarOrigens: por ordem, depois pelo nome', () => {
  it('dado ordens iguais e diferentes, então ordena por ordem e desempata por nome', () => {
    const r = ordenarOrigens([
      origem({ id: 'c', nome: 'Indicação', ordem: 2 }),
      origem({ id: 'b', nome: 'Feira', ordem: 1 }),
      origem({ id: 'a', nome: 'Árvore', ordem: 1 }),
    ])
    expect(r.map((o) => o.id)).toEqual(['a', 'b', 'c'])
  })

  it('não muta a lista recebida', () => {
    const entrada = [origem({ id: 'b', ordem: 2 }), origem({ id: 'a', ordem: 1 })]
    ordenarOrigens(entrada)
    expect(entrada.map((o) => o.id)).toEqual(['b', 'a'])
  })
})

describe('opcoesOrigem: ativas, e a atual inativa na edição', () => {
  it('dado só ativas e nenhuma atual, então devolve as ativas com o nome puro', () => {
    expect(opcoesOrigem([origem({ id: 'x', nome: 'Feira' })], null)).toEqual([{ valor: 'x', rotulo: 'Feira' }])
  })

  it('dado origem atual inativa, então acrescenta " (inativa)"', () => {
    const ativa = origem({ id: 'a', nome: 'Feira', ordem: 1 })
    const inativa = origem({ id: 'i', nome: 'Antiga', ativa: false, ordem: 2 })
    expect(opcoesOrigem([ativa], inativa)).toEqual([
      { valor: 'a', rotulo: 'Feira' },
      { valor: 'i', rotulo: 'Antiga (inativa)' },
    ])
  })

  it('dado origem atual que já está entre as ativas, então não repete a opção', () => {
    const ativa = origem({ id: 'a', nome: 'Feira' })
    expect(opcoesOrigem([ativa], ativa)).toEqual([{ valor: 'a', rotulo: 'Feira' }])
  })
})

describe('estadoOrigem: o select de origem', () => {
  it('dado carregando, então desabilitado e sem link', () => {
    expect(estadoOrigem('carregando', 0)).toMatchObject({ desabilitado: true, linkCadastro: false })
  })

  it('dado falha ao carregar, então desabilitado com dica de falha e sem link', () => {
    expect(estadoOrigem('erro', 0)).toMatchObject({ desabilitado: true, linkCadastro: false, dica: 'Não foi possível carregar as origens.' })
  })

  it('dado nenhuma origem ativa, então desabilitado, com dica e link para cadastrar', () => {
    expect(estadoOrigem('pronto', 0)).toEqual({
      placeholder: 'Sem origens cadastradas', dica: 'Cadastre origens em Configurações.', desabilitado: true, linkCadastro: true,
    })
  })

  it('dado origens ativas, então habilitado e sem dica', () => {
    expect(estadoOrigem('pronto', 3)).toEqual({ placeholder: 'Selecione', dica: '', desabilitado: false, linkCadastro: false })
  })
})

describe('origem no payload', () => {
  it('dado origem vazia, então o payload manda null; escolhida, manda o id', () => {
    expect(montarPayload({ ...formVazio(), nome: 'Ana', telefone: '1' }).origemId).toBeNull()
    expect(montarPayload({ ...formVazio(), nome: 'Ana', telefone: '1', origemId: 'uuid-1' }).origemId).toBe('uuid-1')
  })

  it('dado ficha com origem, então o formulário a pré-seleciona; sem origem, fica vazio', () => {
    const base = {
      nome: 'Ana', razaoSocial: null, nomeFantasia: null, email: null, modalidade: null, prioridade: null,
      temperatura: null, valorEstimadoCentavos: null, observacoes: null, telefones: [], documentos: [], endereco: null,
    }
    expect(formDaFicha({ ...base, origemId: null }).origemId).toBe('')
    expect(formDaFicha({ ...base, origemId: 'o-1' }).origemId).toBe('o-1')
  })
})
