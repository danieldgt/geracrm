import { describe, it, expect } from 'vitest'
import {
  decidirAcaoAoSoltar, ganhoDaFicha, ganhoPelaEmpresa, ganhoPeloEndereco, ganhoVazio, itensDoMenu, mapearErrosGanho,
  payloadGanho, payloadNovaOportunidade, payloadPerda, payloadTransferencia, rotuloDoPedido, validarGanhoLocal,
  validarNovaOportunidade, validarPerda, validarTransferencia, type ValoresGanho,
} from './funil-acoes.regras.js'

const completo: ValoresGanho = {
  cnpj: '11.222.333/0001-81', razaoSocial: ' Acme Ltda ', nomeFantasia: 'Acme', cep: '01310-100',
  logradouro: 'Av. Paulista', numero: '1000', complemento: '', bairro: 'Bela Vista', cidade: 'São Paulo', uf: 'sp',
}

describe('decidirAcaoAoSoltar', () => {
  it('mesma coluna só reordena, qualquer que seja o tipo', () => {
    expect(decidirAcaoAoSoltar('a', 'a', 'ganho')).toBe('reordenar')
  })
  it('ganho e perdido abrem o modal; aberto move direto', () => {
    expect(decidirAcaoAoSoltar('a', 'b', 'ganho')).toBe('abrir_ganho')
    expect(decidirAcaoAoSoltar('a', 'b', 'perdido')).toBe('abrir_perda')
    expect(decidirAcaoAoSoltar('a', 'b', 'aberto')).toBe('mover')
  })
})

describe('payloadGanho', () => {
  it('só dígitos em CNPJ e CEP, UF maiúscula, vazio vira null, pedido só quando escolhido', () => {
    expect(payloadGanho(completo, 3, '')).toEqual({
      versao: 3,
      dados: {
        cnpj: '11222333000181', razaoSocial: 'Acme Ltda', nomeFantasia: 'Acme',
        endereco: { cep: '01310100', logradouro: 'Av. Paulista', numero: '1000', complemento: null, bairro: 'Bela Vista', cidade: 'São Paulo', uf: 'SP' },
      },
    })
    expect(payloadGanho(completo, 3, 'p1').pedidoId).toBe('p1')
  })
})

describe('validarGanhoLocal', () => {
  it('usa a regra do shared: vazio acusa os nove campos; completo passa', () => {
    expect(Object.keys(validarGanhoLocal(ganhoVazio()))).toHaveLength(9)
    expect(validarGanhoLocal(completo)).toEqual({})
  })
  it('CNPJ com dígito errado é recusado', () => {
    expect(validarGanhoLocal({ ...completo, cnpj: '11.222.333/0001-82' }).cnpj).toBe('CNPJ inválido')
  })
})

describe('mapearErrosGanho', () => {
  it('422 de dados mínimos vira erro por campo', () => {
    const r = mapearErrosGanho({ erro: 'ganho.dados_minimos', mensagem: 'Faltam dados', campos: { cnpj: 'CNPJ inválido', uf: 'Informe a UF' } })
    expect(r).toEqual({ campos: { cnpj: 'CNPJ inválido', uf: 'Informe a UF' }, pedido: null, geral: null })
  })
  it('campo desconhecido não some: vai para o erro geral', () => {
    const r = mapearErrosGanho({ erro: 'ganho.dados_minimos', campos: { cnpj: 'x', zzz: 'Estranho' } })
    expect(r.campos).toEqual({ cnpj: 'x' })
    expect(r.geral).toBe('Estranho')
  })
  it('pedido inválido vai para o select de pedido', () => {
    expect(mapearErrosGanho({ erro: 'ganho.pedido_invalido', mensagem: 'Outro cliente' }).pedido).toBe('Outro cliente')
  })
  it('outro erro mostra a mensagem do servidor; corpo vazio não quebra', () => {
    expect(mapearErrosGanho({ erro: 'move.conflito', mensagem: 'Recarregue' }).geral).toBe('Recarregue')
    expect(mapearErrosGanho(null)).toEqual({ campos: {}, pedido: null, geral: null })
  })
})

describe('pré-preenchimento', () => {
  it('ganhoDaFicha pega o CNPJ fiscal (ignora CPF) e o endereço', () => {
    const v = ganhoDaFicha({
      razaoSocial: 'R', nomeFantasia: 'F',
      documentos: [{ tipo: 'cpf', numero: '123', fiscal: true }, { tipo: 'cnpj', numero: '2', fiscal: false }, { tipo: 'cnpj', numero: '1', fiscal: true }],
      endereco: { cep: '01310100', logradouro: 'L', numero: '1', complemento: null, bairro: 'B', cidade: 'C', uf: 'SP' },
    })
    expect(v).toMatchObject({ cnpj: '1', razaoSocial: 'R', nomeFantasia: 'F', cep: '01310100', complemento: '', uf: 'SP' })
    expect(ganhoDaFicha({ razaoSocial: null, nomeFantasia: null, documentos: [], endereco: null })).toEqual(ganhoVazio())
  })
  it('consulta de CNPJ sobrescreve razão/fantasia/endereço e mantém o que veio vazio', () => {
    const v = ganhoPelaEmpresa({ ...ganhoVazio(), numero: '77', complemento: 'Sala 1' }, {
      razaoSocial: 'Empresa SA', nomeFantasia: null, situacao: 'ATIVA',
      endereco: { cep: '01310100', logradouro: 'Rua X', numero: null, complemento: null, bairro: 'Centro', cidade: 'Recife', uf: 'PE' },
    })
    expect(v).toMatchObject({ razaoSocial: 'Empresa SA', nomeFantasia: '', numero: '77', complemento: 'Sala 1', cidade: 'Recife', uf: 'PE' })
  })
  it('consulta de CEP não toca em número nem complemento', () => {
    const v = ganhoPeloEndereco({ ...ganhoVazio(), numero: '5', complemento: 'Ap 2' },
      { cep: '50000000', logradouro: 'Rua Y', numero: '999', complemento: 'zzz', bairro: 'B', cidade: 'C', uf: 'PE' })
    expect(v).toMatchObject({ numero: '5', complemento: 'Ap 2', logradouro: 'Rua Y' })
  })
})

describe('perder, transferir e nova oportunidade', () => {
  it('perda exige motivo; descrição só vai quando preenchida', () => {
    expect(validarPerda({ motivoCodigo: ' ', descricao: '' }).motivoCodigo).toBeTruthy()
    expect(validarPerda({ motivoCodigo: 'preco', descricao: '' })).toEqual({})
    expect(payloadPerda({ motivoCodigo: 'preco', descricao: ' ' }, 2)).toEqual({ motivoCodigo: 'preco', versao: 2 })
    expect(payloadPerda({ motivoCodigo: 'preco', descricao: ' caro ' }, 2).descricao).toBe('caro')
  })
  it('transferência exige vendedor e motivo', () => {
    expect(Object.keys(validarTransferencia({ usuarioId: '', motivo: '' }))).toEqual(['usuarioId', 'motivo'])
    expect(validarTransferencia({ usuarioId: 'u', motivo: 'x' })).toEqual({})
    expect(payloadTransferencia({ usuarioId: ' u ', motivo: ' m ' })).toEqual({ usuarioId: 'u', motivo: 'm' })
  })
  it('nova oportunidade exige contato e etapa; valor só quando positivo', () => {
    expect(Object.keys(validarNovaOportunidade({ contatoId: '', etapaId: '', valorCentavos: null }))).toEqual(['contatoId', 'etapaId'])
    expect(payloadNovaOportunidade({ contatoId: 'c', etapaId: 'e', valorCentavos: 0 })).toEqual({ contatoId: 'c', etapaId: 'e' })
    expect(payloadNovaOportunidade({ contatoId: 'c', etapaId: 'e', valorCentavos: 15000 }).valorCentavos).toBe(15000)
  })
})

describe('menu do card e rótulo de pedido', () => {
  it('card aberto tem as seis ações; fechado perde Ganhar e Perder', () => {
    expect(itensDoMenu('aberto').map((i) => i.acao)).toEqual(['ganhar', 'perder', 'transferir', 'tarefa', 'ficha', 'conversa'])
    expect(itensDoMenu('ganho').map((i) => i.acao)).toEqual(['transferir', 'tarefa', 'ficha', 'conversa'])
  })
  it('rótulo do pedido traz número, estado e valor', () => {
    const r = rotuloDoPedido({ id: 'p', estado: 'efetivado', totalCentavos: 150000, numeroExterno: '1234', criadoEm: '2026-11-03T15:00:00Z' })
    expect(r).toContain('Pedido 1234')
    expect(r).toContain('Efetivado')
    expect(r).toMatch(/1\.500,00/)
  })
})
