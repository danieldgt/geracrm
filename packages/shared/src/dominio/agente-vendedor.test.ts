import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import { fatiarMensagem, respostaDoAgente, verificarNumerosNaResposta } from './agente-vendedor.js'
import { decidirAlcada, podeTransitar } from './pedido.js'
import { textoParaIndice } from './catalogo.js'

describe('Guardrail numérico do agente', () => {
  it('dado preço que veio de ferramenta, quando a resposta o cita, então passa', () => {
    expect(verificarNumerosNaResposta('A camiseta sai por R$ 49,90 no atacado.', new Set([4990]))).toEqual([])
  })
  it('dado preço inventado, quando a resposta o cita, então aponta o número', () => {
    expect(verificarNumerosNaResposta('Fica R$ 39,90 pra você', new Set([4990]))).toEqual([3990])
  })
  it('reconhece "1.299,00", "12.90" e "12 reais"', () => {
    expect(verificarNumerosNaResposta('Plano Pro: R$ 1.299,00/mês', new Set([129900]))).toEqual([])
    expect(verificarNumerosNaResposta('custa R$12.90', new Set([1290]))).toEqual([])
    expect(verificarNumerosNaResposta('são 12 reais', new Set([1200]))).toEqual([])
  })
  it('ignora número que não é dinheiro (quantidade, tamanho)', () => {
    expect(verificarNumerosNaResposta('Temos 12 peças no tamanho 42', new Set())).toEqual([])
    expect(verificarNumerosNaResposta('Entrega em 2 dias, 10 unidades', new Set())).toEqual([])
  })
  it('pega dinheiro sem R$: "custa 1299", "fica 39,90", "59 cada", "1.299,00 por mês"', () => {
    expect(verificarNumerosNaResposta('custa 1299 cada', new Set())).toEqual([129900])
    expect(verificarNumerosNaResposta('fica 39,90 a unidade', new Set([3990]))).toEqual([])
    expect(verificarNumerosNaResposta('fica 39,90 a unidade', new Set())).toEqual([3990])
    expect(verificarNumerosNaResposta('o plano sai por 599 mensais', new Set([59900]))).toEqual([])
    expect(verificarNumerosNaResposta('são 1.299,00 por mês', new Set())).toEqual([129900])
  })
})

describe('Resposta estruturada', () => {
  it('exige 1 a 3 mensagens e confiança 0..1', () => {
    expect(respostaDoAgente.safeParse({ mensagens: [], confianca: 0.5 }).success).toBe(false)
    expect(respostaDoAgente.safeParse({ mensagens: ['oi'], confianca: 1.5 }).success).toBe(false)
    expect(respostaDoAgente.safeParse({ mensagens: ['oi'], confianca: 0.9 }).success).toBe(true)
  })
  it('slots é PARCIAL: {} e um subconjunto passam; chave desconhecida reprova; o schema não exige nenhum slot', () => {
    expect(respostaDoAgente.safeParse({ mensagens: ['oi'], confianca: 0.9, slots: {} }).success).toBe(true)
    expect(respostaDoAgente.safeParse({ mensagens: ['oi'], confianca: 0.9, slots: { cidade: 'Fortaleza' } }).success).toBe(true)
    expect(respostaDoAgente.safeParse({ mensagens: ['oi'], confianca: 0.9, slots: { inventada: 'x' } }).success).toBe(false)
    const esquema = z.toJSONSchema(respostaDoAgente, { target: 'draft-7' }) as unknown as { properties: { slots: { required?: string[] } } }
    expect(esquema.properties.slots.required).toBeUndefined()
  })
})

describe('fatiarMensagem', () => {
  it('não fatia texto curto', () => expect(fatiarMensagem('oi')).toEqual(['oi']))
  it('fatia por parágrafo quando passa do limite', () => {
    const r = fatiarMensagem('Primeiro parágrafo.\n\nSegundo parágrafo bem maior aqui.', 25)
    expect(r.length).toBeGreaterThan(1)
    expect(r.every((p) => p.length <= 25)).toBe(true)
  })
})

describe('Alçada', () => {
  it('padrão: nunca efetiva sozinho', () => {
    expect(decidirAlcada({ totalCentavos: 100 }, { valorMaxAutonomoCentavos: 0, descontoMaxPct: 0, efetivaSozinho: false }))
      .toEqual({ acao: 'aguardar_vendedor', motivo: 'efetivacao_manual' })
  })
  it('dentro do valor e com efetivação automática, efetiva', () => {
    expect(decidirAlcada({ totalCentavos: 50_000 }, { valorMaxAutonomoCentavos: 100_000, descontoMaxPct: 0, efetivaSozinho: true }))
      .toEqual({ acao: 'efetivar' })
  })
  it('acima do valor espera vendedor; desconto fora da política idem', () => {
    const a = { valorMaxAutonomoCentavos: 100_000, descontoMaxPct: 0, efetivaSozinho: true }
    expect(decidirAlcada({ totalCentavos: 100_001 }, a)).toEqual({ acao: 'aguardar_vendedor', motivo: 'acima_do_valor' })
    expect(decidirAlcada({ totalCentavos: 10, descontoPct: 5 }, a)).toEqual({ acao: 'aguardar_vendedor', motivo: 'desconto' })
  })
})

describe('Máquina de estados do pedido', () => {
  it('rascunho → aguardando_confirmacao → confirmado → enviando → efetivado', () => {
    expect(podeTransitar('rascunho', 'aguardando_confirmacao')).toBe(true)
    expect(podeTransitar('aguardando_confirmacao', 'confirmado')).toBe(true)
    expect(podeTransitar('confirmado', 'enviando')).toBe(true)
    expect(podeTransitar('enviando', 'efetivado')).toBe(true)
  })
  it('efetivado é final', () => expect(podeTransitar('efetivado', 'rascunho')).toBe(false))
})

describe('textoParaIndice', () => {
  it('junta referência, descrição, categoria e atributos agregados, sem preço', () => {
    const t = textoParaIndice({
      referencia: 'CAM-001', descricao: 'Camiseta básica', categoria: 'Camisetas',
      atributos: [{ cor: 'verde', tamanho: 'P' }, { cor: 'azul', tamanho: 'G' }],
    })
    expect(t).toContain('cor: verde, azul')
    expect(t).toContain('tamanho: P, G')
    expect(t).not.toMatch(/R\$/)
  })
})
