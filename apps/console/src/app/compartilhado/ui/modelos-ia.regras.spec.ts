import { describe, it, expect } from 'vitest'
import {
  agruparPorPreco, alternarCodigo, badgesDoModelo, codigosParaSalvar, formatarUsd, linhaDeCusto, mudouPermissao,
  permitidosDe, pontosQualidade, rotuloProvedor, rotuloQualidade, type ModeloComPermissao, type ModeloIa,
} from './modelos-ia.regras.js'

function modelo(parcial: Partial<ModeloIa> & { codigo: string }): ModeloIa {
  return {
    provedor: 'groq', modelo: 'x', nome: parcial.codigo, descricao: '', gratuito: true, ferramentas: true,
    saidaEstruturada: false, qualidade: 3, custoEntradaUsdMilhao: 0, custoSaidaUsdMilhao: 0, janelaContexto: 128000,
    observacao: '', padrao: false, disponivel: true, motivoIndisponivel: null, ...parcial,
  }
}

describe('Linha de custo: "US$ entrada / saída por 1M tokens"', () => {
  it('dado modelo pago, então mostra os dois custos com vírgula decimal', () => {
    expect(linhaDeCusto({ custoEntradaUsdMilhao: 3, custoSaidaUsdMilhao: 15 })).toBe('US$ 3 / 15 por 1M tokens')
    expect(linhaDeCusto({ custoEntradaUsdMilhao: 0.15, custoSaidaUsdMilhao: 0.6 })).toBe('US$ 0,15 / 0,6 por 1M tokens')
  })

  it('dado custo zero nos dois lados, então null — gratuito não exibe linha de custo', () => {
    expect(linhaDeCusto({ custoEntradaUsdMilhao: 0, custoSaidaUsdMilhao: 0 })).toBeNull()
  })

  it('dado só um lado zero, então a linha aparece (há custo em algum lado)', () => {
    expect(linhaDeCusto({ custoEntradaUsdMilhao: 0, custoSaidaUsdMilhao: 0.5 })).toBe('US$ 0 / 0,5 por 1M tokens')
  })

  it('formatarUsd corta zeros à direita e nunca varia por ambiente', () => {
    expect(formatarUsd(0.075)).toBe('0,075')
    expect(formatarUsd(1.5)).toBe('1,5')
    expect(formatarUsd(10)).toBe('10')
    expect(formatarUsd(Number.NaN)).toBe('0')
  })
})

describe('Qualidade em pontos', () => {
  it('dado 4, então quatro cheios e um vazio, com rótulo falado', () => {
    expect(pontosQualidade(4)).toEqual([true, true, true, true, false])
    expect(rotuloQualidade(4)).toBe('Qualidade 4 de 5')
  })

  it('dado valor fora da faixa, então não quebra: 0 vira tudo vazio, 9 vira tudo cheio', () => {
    expect(pontosQualidade(0)).toEqual([false, false, false, false, false])
    expect(pontosQualidade(9)).toEqual([true, true, true, true, true])
    expect(rotuloQualidade(9)).toBe('Qualidade 5 de 5')
    expect(pontosQualidade(Number.NaN)).toEqual([false, false, false, false, false])
  })
})

describe('Agrupar grátis / pago, mantendo a ordem da API em cada grupo', () => {
  it('dado catálogo misto, então gratuitos e pagos separados e ordenados como vieram', () => {
    const itens = [
      modelo({ codigo: 'a', gratuito: false }), modelo({ codigo: 'b', gratuito: true }),
      modelo({ codigo: 'c', gratuito: false }), modelo({ codigo: 'd', gratuito: true }),
    ]
    const g = agruparPorPreco(itens)
    expect(g.gratuitos.map((m) => m.codigo)).toEqual(['b', 'd'])
    expect(g.pagos.map((m) => m.codigo)).toEqual(['a', 'c'])
  })

  it('badges em ordem fixa: preço, ferramentas, saída estruturada', () => {
    expect(badgesDoModelo({ gratuito: true, ferramentas: true, saidaEstruturada: true })).toEqual(['Grátis', 'ferramentas', 'saída estruturada'])
    expect(badgesDoModelo({ gratuito: false, ferramentas: false, saidaEstruturada: false })).toEqual(['Pago'])
  })

  it('provedor desconhecido (API mais nova) sai cru, conhecido sai com nome', () => {
    expect(rotuloProvedor('claude')).toBe('Anthropic')
    expect(rotuloProvedor('novo-fornecedor')).toBe('novo-fornecedor')
  })
})

describe('Painel do staff: das caixas marcadas ao corpo do PUT', () => {
  const catalogo: ModeloComPermissao[] = [
    { ...modelo({ codigo: 'groq-llama' }), permitido: true },
    { ...modelo({ codigo: 'claude-sonnet', gratuito: false }), permitido: false },
    { ...modelo({ codigo: 'gemini-flash' }), permitido: true },
  ]

  it('dado o catálogo com a marca da API, então o conjunto inicial é o que está permitido', () => {
    expect([...permitidosDe(catalogo)].sort()).toEqual(['gemini-flash', 'groq-llama'])
  })

  it('alternar não muta o conjunto original', () => {
    const inicial = permitidosDe(catalogo)
    const depois = alternarCodigo(inicial, 'claude-sonnet', true)
    expect(depois.has('claude-sonnet')).toBe(true)
    expect(inicial.has('claude-sonnet')).toBe(false)
    expect(alternarCodigo(depois, 'groq-llama', false).has('groq-llama')).toBe(false)
  })

  it('o corpo do PUT segue a ORDEM DO CATÁLOGO e ignora código que não existe nele', () => {
    const marcados = new Set(['gemini-flash', 'fantasma', 'groq-llama'])
    expect(codigosParaSalvar(marcados, catalogo)).toEqual(['groq-llama', 'gemini-flash'])
  })

  it('nenhuma caixa marcada vira lista vazia — e vazio é "volta ao padrão" na API', () => {
    expect(codigosParaSalvar(new Set(), catalogo)).toEqual([])
  })

  it('"Salvar" só habilita quando o conjunto mudou de verdade', () => {
    const a = new Set(['x', 'y'])
    expect(mudouPermissao(a, new Set(['y', 'x']))).toBe(false)
    expect(mudouPermissao(a, new Set(['x']))).toBe(true)
    expect(mudouPermissao(a, new Set(['x', 'z']))).toBe(true)
  })
})
