import { describe, it, expect } from 'vitest'
import { mensagemViolacao, regrasPedidoDe, validarRegrasPedido } from './regras-pedido.js'

/**
 * PED-05 / INV-27 — regras comerciais do perfil vertical, como função PURA.
 * Os exemplos vêm dos cenários BDD §8: "7 peças, mínimo 10 → faltam 3".
 */
const pedido = (totalPecas: number, totalCentavos: number, itens: { sku: string; quantidade: number }[] = []) =>
  ({ totalPecas, totalCentavos, itens })

describe('validarRegrasPedido', () => {
  it('sem regras, qualquer pedido passa', () => {
    expect(validarRegrasPedido({}, pedido(1, 100, [{ sku: 'A', quantidade: 1 }]))).toEqual({ tipo: 'ok' })
  })

  it('dado 7 peças e mínimo 10, então bloqueia e diz que faltam 3', () => {
    const r = validarRegrasPedido({ minimo_pecas: 10 }, pedido(7, 99_900))
    expect(r).toEqual({ tipo: 'abaixo_do_minimo', faltam: { pecas: 3 } })
    expect(mensagemViolacao(r as never)).toContain('faltam 3 peça(s)')
  })

  it('no limite exato do mínimo, passa', () => {
    expect(validarRegrasPedido({ minimo_pecas: 10 }, pedido(10, 1))).toEqual({ tipo: 'ok' })
    expect(validarRegrasPedido({ minimo_centavos: 50_000 }, pedido(1, 50_000))).toEqual({ tipo: 'ok' })
  })

  it('mínimo em valor: diz quanto falta em centavos', () => {
    const r = validarRegrasPedido({ minimo_centavos: 50_000 }, pedido(20, 42_050))
    expect(r).toEqual({ tipo: 'abaixo_do_minimo', faltam: { centavos: 7_950 } })
    expect(mensagemViolacao(r as never)).toContain('R$ 79.50')
  })

  it('mínimo em peças E valor violados: as duas faltas vêm juntas', () => {
    const r = validarRegrasPedido({ minimo_pecas: 10, minimo_centavos: 50_000 }, pedido(4, 10_000))
    expect(r).toEqual({ tipo: 'abaixo_do_minimo', faltam: { pecas: 6, centavos: 40_000 } })
  })

  it('múltiplo de grade: quantidade que não fecha a grade nomeia o item e o múltiplo', () => {
    const r = validarRegrasPedido(
      { multiplo_pecas: 3 },
      pedido(5, 1, [{ sku: 'CONJUNTO LAILA', quantidade: 3 }, { sku: 'CONJUNTO KARINE', quantidade: 2 }]),
    )
    expect(r).toEqual({ tipo: 'multiplo_invalido', sku: 'CONJUNTO KARINE', multiplo: 3, quantidade: 2 })
    expect(mensagemViolacao(r as never)).toContain('CONJUNTO KARINE')
    expect(mensagemViolacao(r as never)).toContain('múltiplos de 3')
  })

  it('múltiplo 1 (ou ausente) não restringe nada', () => {
    expect(validarRegrasPedido({ multiplo_pecas: 1 }, pedido(1, 1, [{ sku: 'A', quantidade: 7 }]))).toEqual({ tipo: 'ok' })
  })

  it('⚠️ o item errado vem ANTES do total: ajustar o item muda o total, não o contrário', () => {
    const r = validarRegrasPedido(
      { minimo_pecas: 10, multiplo_pecas: 6 },
      pedido(4, 1, [{ sku: 'A', quantidade: 4 }]),
    )
    expect(r.tipo).toBe('multiplo_invalido')
  })

  it('quantidade fracionária nunca é múltiplo', () => {
    const r = validarRegrasPedido({ multiplo_pecas: 2 }, pedido(2.5, 1, [{ sku: 'A', quantidade: 2.5 }]))
    expect(r.tipo).toBe('multiplo_invalido')
  })
})

describe('regrasPedidoDe (parse do jsonb)', () => {
  it('lê as três chaves e ignora o que não conhece', () => {
    expect(regrasPedidoDe({ minimo_pecas: 10, minimo_centavos: 5000, multiplo_pecas: 3, mix_minimo: 2 }))
      .toMatchObject({ minimo_pecas: 10, minimo_centavos: 5000, multiplo_pecas: 3 })
  })

  it('⚠️ jsonb torto vale como SEM regras — nunca bloqueia toda venda por um JSON errado', () => {
    expect(regrasPedidoDe({ minimo_pecas: 'dez' })).toEqual({})
    expect(regrasPedidoDe(null)).toEqual({})
    expect(regrasPedidoDe('{}')).toEqual({})
  })
})
