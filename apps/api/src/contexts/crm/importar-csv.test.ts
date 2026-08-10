import { describe, it, expect } from 'vitest'
import { parseCsvContatos } from './importar-csv.js'

/** Importação de contatos por CSV — o parser puro (validação no servidor). */
describe('parseCsvContatos', () => {
  it('lê nome + telefone + documento, separador vírgula', () => {
    const r = parseCsvContatos('nome,telefone,cnpj\nZé da Silva,81998617049,11222333000181')
    expect(r.rejeicoes).toEqual([])
    expect(r.linhas).toHaveLength(1)
    expect(r.linhas[0]).toMatchObject({ nome: 'Zé da Silva', tipoDocumento: 'cnpj', documento: '11222333000181' })
    expect(r.linhas[0]!.e164).toMatch(/^\+55/)
  })

  it('auto-detecta separador ponto-e-vírgula (planilha BR)', () => {
    const r = parseCsvContatos('Nome;Celular\nMaria;(81) 99999-0000')
    expect(r.linhas).toHaveLength(1)
    expect(r.linhas[0]!.nome).toBe('Maria')
    expect(r.linhas[0]!.e164).toBeDefined()
  })

  it('cabeçalho com acento/caixa é tolerado ("Razão Social")', () => {
    const r = parseCsvContatos('Razão Social;Telefone\nLoja X;81988887777')
    expect(r.linhas).toHaveLength(1)
    expect(r.linhas[0]!.nome).toBe('Loja X')
  })

  it('respeita aspas: vírgula dentro do campo não quebra', () => {
    const r = parseCsvContatos('nome,telefone\n"Silva, Comércio LTDA",81998617049')
    expect(r.linhas[0]!.nome).toBe('Silva, Comércio LTDA')
  })

  it('nome vazio e telefone inválido viram rejeição com o número da linha', () => {
    const r = parseCsvContatos('nome,telefone\n,81998617049\nJoão,123')
    expect(r.linhas).toHaveLength(0)
    expect(r.rejeicoes).toEqual([
      { linha: 2, motivo: 'nome_vazio' },
      { linha: 3, motivo: 'telefone_invalido' },
    ])
  })

  it('CPF (11) e CNPJ (14) são distinguidos; tamanho errado rejeita', () => {
    const r = parseCsvContatos('nome,documento\nPessoa,52998224725\nEmpresa,11222333000181\nErro,123')
    expect(r.linhas[0]).toMatchObject({ tipoDocumento: 'cpf' })
    expect(r.linhas[1]).toMatchObject({ tipoDocumento: 'cnpj' })
    expect(r.rejeicoes).toContainEqual({ linha: 4, motivo: 'documento_invalido' })
  })

  it('sem coluna de nome → erro claro', () => {
    expect(parseCsvContatos('telefone\n81998617049').rejeicoes).toEqual([{ linha: 1, motivo: 'sem_coluna_nome' }])
  })

  it('nome sem telefone nem documento é válido (só nome é obrigatório)', () => {
    const r = parseCsvContatos('nome\nContato Solto')
    expect(r.linhas).toEqual([{ nome: 'Contato Solto' }])
  })
})
