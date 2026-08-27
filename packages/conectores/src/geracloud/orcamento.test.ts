import { describe, it, expect } from 'vitest'
import { montarOrcamento, paraReais, dataBr, traduzirRespostaOrcamento } from './orcamento.js'

/**
 * ⚠️ O contrato foi extraído do JavaScript do catálogo do fornecedor, não de
 * documentação — o ERP não expõe especificação. Estes testes são o que impede
 * que alguém "simplifique" um detalhe que parece arbitrário e só quebra do lado
 * do cliente, no orçamento que ele recebe.
 */
const BASE = {
  clientePDV: { id: 42, tipo: 'PESSOA JURIDICA', cnpj: '11222333000181' },
  catalogo: { id: 7 },
  tabelaPreco: { id: 80 },
  chaveIdempotencia: 'ped-1:3',
  agora: new Date(2026, 7, 27, 9, 5, 3),
}

describe('⚠️ Dinheiro: reais decimais, não centavos', () => {
  /**
   * Nós guardamos centavos inteiros; o ERP quer reais com duas casas. Errar aqui
   * é cobrar R$ 8.990,00 no lugar de R$ 89,90 — e o número chega bonito no
   * orçamento do cliente, sem erro nenhum no caminho.
   */
  it('converte centavos para reais', () => {
    expect(paraReais(8990)).toBe(89.9)
    expect(paraReais(100)).toBe(1)
    expect(paraReais(1)).toBe(0.01)
    expect(paraReais(0)).toBe(0)
  })

  it('não deixa dízima escapar', () => {
    // 3 × 3333 centavos = 99,99 — sem toFixed viraria 99.99000000000001
    expect(paraReais(3333 * 3)).toBe(99.99)
  })
})

describe('⚠️ Data em DD/MM/YYYY HH:mm:ss', () => {
  /** O ERP não aceita ISO nesta rota. */
  it('formata como o catálogo formata', () => {
    expect(dataBr(new Date(2026, 7, 27, 9, 5, 3))).toBe('27/08/2026 09:05:03')
  })

  it('preenche com zero à esquerda', () => {
    expect(dataBr(new Date(2026, 0, 1, 0, 0, 0))).toBe('01/01/2026 00:00:00')
  })
})

describe('O corpo do orçamento', () => {
  const itens = [
    { estoque: { id: 1, codigoBarra: { id: 555 } }, produtoPreco: { id: 90 }, quantidade: 2, precoUnitarioCentavos: 8990 },
    { estoque: { id: 2, codigoBarra: { id: 556 } }, produtoPreco: { id: 91 }, quantidade: 1, precoUnitarioCentavos: 5000 },
  ]

  it('soma o total em reais', () => {
    const c = montarOrcamento({ ...BASE, itens })
    expect(c['valor']).toBe(229.8)   // 2×89,90 + 50,00
  })

  /**
   * ⚠️ `precoDoMomento` é o TOTAL DA LINHA, apesar do nome dizer o contrário.
   * Está assim no `carregarDadosPedido` do catálogo. Mandar o unitário faria o
   * orçamento sair com valor errado, em silêncio.
   */
  it('precoDoMomento é preço × quantidade, não o unitário', () => {
    const c = montarOrcamento({ ...BASE, itens })
    const linhas = c['itens'] as Record<string, unknown>[]
    expect(linhas[0]!['precoDoMomento']).toBe(179.8)   // 2 × 89,90
    expect(linhas[1]!['precoDoMomento']).toBe(50)
  })

  it('leva o objeto de estoque inteiro, não só um id', () => {
    const c = montarOrcamento({ ...BASE, itens })
    const linhas = c['itens'] as Record<string, unknown>[]
    expect(linhas[0]!['estoque']).toMatchObject({ codigoBarra: { id: 555 } })
  })

  /**
   * ⚠️ Sem `produtoPreco` o ERP devolve 400 com "Ocorreu um erro ao enviar o
   * Pedido! :( null" — mensagem que não diz o que falta. Medido ao vivo em
   * 27/ago: a MESMA requisição, só com este campo a mais, passou de 400 para 200
   * com o PDF do orçamento. É o que liga o item à tabela de preço.
   */
  it('⚠️ o item leva produtoPreco — sem ele o ERP recusa sem explicar', () => {
    const c = montarOrcamento({ ...BASE, itens })
    const linhas = c['itens'] as Record<string, unknown>[]
    expect(linhas[0]!['produtoPreco']).toMatchObject({ id: 90 })
    expect(linhas[1]!['produtoPreco']).toMatchObject({ id: 91 })
  })

  it('status é sempre Orcamento nesta via', () => {
    expect(montarOrcamento({ ...BASE, itens })['status']).toBe('Orcamento')
  })

  /**
   * ⚠️ O GANCHO DE IDEMPOTÊNCIA. O ERP não tem chave própria, e `observacao` é o
   * único texto livre que atravessa. Sem ela, reconciliar depois de um timeout
   * seria busca por cliente + valor + janela — ambígua por natureza (INV-53).
   */
  it('a chave de idempotência viaja em observacao', () => {
    const c = montarOrcamento({ ...BASE, itens })
    expect(c['observacao']).toContain('ped-1:3')
  })

  it('pedido sem itens soma zero em vez de NaN', () => {
    expect(montarOrcamento({ ...BASE, itens: [] })['valor']).toBe(0)
  })
})

describe('⚠️ Resposta: falha de negócio é tipificada, nunca exceção', () => {
  /** A resposta é um arquivo; o número do pedido NÃO volta. Vazio é honesto. */
  it('sucesso devolve numeroExterno VAZIO — o ERP não manda o número', () => {
    const r = traduzirRespostaOrcamento(200, '')
    expect(r).toEqual({ ok: true, valor: { numeroExterno: '' } })
  })

  it('estoque insuficiente tem motivo próprio, com ação corretiva na tela', () => {
    const r = traduzirRespostaOrcamento(400, 'Produto indisponível no estoque')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.falha.tipo).toBe('estoque_insuficiente')
  })

  it('documento faltando aponta para o cadastro', () => {
    const r = traduzirRespostaOrcamento(400, 'Obrigatório informar o CNPJ')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.falha.tipo).toBe('cliente_sem_cadastro_fiscal')
  })

  /**
   * ⚠️ O caso que o INV-53 existe para proteger: com 504 ou 5xx o orçamento PODE
   * ter sido criado. Reenviar às cegas duplicaria no ERP do cliente.
   */
  it('timeout e erro de servidor viram resposta_perdida, nunca retry', () => {
    for (const s of [408, 504, 500, 502]) {
      const r = traduzirRespostaOrcamento(s, '')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.falha.tipo).toBe('resposta_perdida')
    }
  })

  it('400 genérico é nao_chegou — pode retentar sem risco', () => {
    const r = traduzirRespostaOrcamento(400, 'requisição malformada')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.falha.tipo).toBe('nao_chegou')
  })
})
