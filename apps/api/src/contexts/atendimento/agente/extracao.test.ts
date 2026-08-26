import { describe, it, expect } from 'vitest'
import { validarExtracao, sinaisPreenchidos } from './extracao.js'

/**
 * ⚠️ Esta é a fronteira entre o que o modelo ACHA que leu e o que o produto
 * aceita como verdade. O que ela protege não é o formato — é o cadastro do
 * cliente do nosso cliente.
 */
const CNPJ_VALIDO = '11.222.333/0001-81'

describe('O caminho normal', () => {
  it('aceita o que veio bem', () => {
    const r = validarExtracao({
      tipoCompra: 'revenda', cidade: 'Boa Vista', volume: '20 peças por mês', cnpj: CNPJ_VALIDO,
    })
    expect(r).toMatchObject({
      tipoCompra: 'revenda', cidade: 'Boa Vista', volume: '20 peças por mês',
      cnpj: '11222333000181', descartados: [],
    })
  })

  it('extração vazia não é erro — a conversa pode não ter chegado lá', () => {
    const r = validarExtracao({})
    expect(r.cnpj).toBeNull()
    expect(r.descartados).toEqual([])
  })
})

describe('⚠️ CNPJ: o campo mais perigoso', () => {
  /**
   * Catorze dígitos plausíveis passam por qualquer revisão humana distraída. Só
   * o dígito verificador separa o que o cliente DISSE do que o modelo completou
   * para agradar.
   */
  it('CNPJ bem formatado e inválido é RECUSADO, com motivo', () => {
    const r = validarExtracao({ cnpj: '11.222.333/0001-99' })
    expect(r.cnpj).toBeNull()
    expect(r.descartados).toEqual([
      { campo: 'cnpj', valor: '11.222.333/0001-99', motivo: 'dígito verificador não confere' },
    ])
  })

  it('sequência repetida não passa', () => {
    expect(validarExtracao({ cnpj: '11.111.111/1111-11' }).cnpj).toBeNull()
  })

  it('texto no lugar do número não passa', () => {
    expect(validarExtracao({ cnpj: 'não tenho' }).cnpj).toBeNull()
  })
})

describe('⚠️ O modelo inventando campo é registrado, não ignorado', () => {
  /** Campo fora do esquema é sinal de prompt ruim — e some se ninguém contar. */
  it('campo não previsto vira descarte com motivo', () => {
    const r = validarExtracao({ cidade: 'Manaus', desconto: '10%' })
    expect(r.cidade).toBe('Manaus')
    expect(r.descartados).toEqual([
      { campo: 'desconto', valor: '10%', motivo: 'campo não previsto no esquema' },
    ])
  })

  it('tipo de compra fora do enum não vira nada', () => {
    const r = validarExtracao({ tipoCompra: 'atacado' })
    expect(r.tipoCompra).toBeNull()
    expect(r.descartados[0]?.motivo).toBe('fora dos valores aceitos')
  })

  it('valor que não é texto é descartado em vez de virar string', () => {
    const r = validarExtracao({ cidade: 42 })
    expect(r.cidade).toBeNull()
    expect(r.descartados[0]?.motivo).toBe('não é texto')
  })
})

describe('Cidade tem cara de cidade', () => {
  it('recusa cidade com dígito — costuma ser endereço inteiro', () => {
    expect(validarExtracao({ cidade: 'Rua das Flores 220' }).cidade).toBeNull()
  })

  it('recusa uma letra só', () => {
    expect(validarExtracao({ cidade: 'X' }).cidade).toBeNull()
  })

  it('espaço em volta não invalida', () => {
    expect(validarExtracao({ cidade: '  Boa Vista ' }).cidade).toBe('Boa Vista')
  })
})

describe('Sinais preenchidos', () => {
  const LEAD_NOVO = { jaEhCliente: false, cidade: null, temCnpj: false }

  it('conta o que veio da conversa E o que já estava no cadastro', () => {
    const extraido = validarExtracao({ tipoCompra: 'revenda', volume: '50' })
    expect(sinaisPreenchidos(extraido, { jaEhCliente: true, cidade: 'Manaus', temCnpj: true }))
      .toEqual(['historico', 'cidade', 'cnpj', 'tipo_compra', 'volume'])
  })

  it('lead novo sem nada extraído não tem sinal nenhum', () => {
    expect(sinaisPreenchidos(validarExtracao({}), LEAD_NOVO)).toEqual([])
  })

  /** ⚠️ CNPJ recusado NÃO conta como preenchido — senão o buraco some do resumo. */
  it('campo descartado não conta como sinal', () => {
    const extraido = validarExtracao({ cnpj: '11.222.333/0001-99' })
    expect(sinaisPreenchidos(extraido, LEAD_NOVO)).toEqual([])
  })
})
