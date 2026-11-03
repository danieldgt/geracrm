import { describe, it, expect } from 'vitest'
import { acaoAoTrocarGatilho, avisoSoTemplate, descreverPosVenda, gatilhoAoTrocarAcao, paramsPosVenda, textoDiasDepois } from './automacoes.regras.js'

/** Regras puras do formulário de Automações para o pós-venda (G3). */
const TPL = '0199a3f0-0b1c-7000-8000-0000000000aa'

describe('Par gatilho/ação do pós-venda', () => {
  it('"Pedido efetivado" puxa "Agente envia"; sair dele devolve a ação padrão', () => {
    expect(acaoAoTrocarGatilho('pedido_efetivado', 'criar_tarefa')).toBe('agente_envia')
    expect(acaoAoTrocarGatilho('lead_frio', 'agente_envia')).toBe('criar_tarefa')
    expect(acaoAoTrocarGatilho('lead_frio', 'adicionar_lista')).toBe('adicionar_lista')
  })
  it('"Agente envia" puxa "Pedido efetivado"; sair dela devolve o gatilho padrão', () => {
    expect(gatilhoAoTrocarAcao('agente_envia', 'lead_frio')).toBe('pedido_efetivado')
    expect(gatilhoAoTrocarAcao('criar_tarefa', 'pedido_efetivado')).toBe('dias_sem_comprar')
    expect(gatilhoAoTrocarAcao('criar_tarefa', 'nps_detrator')).toBe('nps_detrator')
  })
})

describe('Parâmetros do pós-venda', () => {
  it('monta o corpo normalizado (texto aparado, template vazio = null)', () => {
    expect(paramsPosVenda({ diasDepois: 3, roteiro: 'nps', texto: ' Nota? ', templateId: '' })).toEqual({
      ok: true, params: { gatilhoParam: { diasDepois: 3 }, acaoParam: { roteiro: 'nps', texto: 'Nota?', templateId: null } },
    })
    expect(paramsPosVenda({ diasDepois: 0, roteiro: 'indicacao', texto: '', templateId: TPL })).toMatchObject({ ok: true })
  })
  it('recusa dias fora de 0..60 e regra sem texto nem template, com a frase que orienta', () => {
    expect(paramsPosVenda({ diasDepois: 61, roteiro: 'nps', texto: 'x', templateId: '' })).toEqual({ ok: false, erro: 'Use de 0 a 60 dias depois da efetivação.' })
    expect(paramsPosVenda({ diasDepois: 0, roteiro: 'nps', texto: ' ', templateId: '' })).toMatchObject({ ok: false, erro: expect.stringContaining('template') })
  })
  it('descrição na lista e texto dos dias', () => {
    expect(textoDiasDepois(0)).toBe('no dia da efetivação')
    expect(textoDiasDepois(1)).toBe('1 dia depois da efetivação')
    expect(descreverPosVenda({ diasDepois: 7 }, { roteiro: 'nps' })).toBe('Quando um pedido é efetivado (7 dias depois da efetivação) → o agente envia: Pesquisa NPS (nota de 0 a 10)')
    expect(descreverPosVenda({}, { roteiro: 'x' })).toContain('mensagem')
  })
  it('só template: avisa que o não-oficial não envia', () => {
    expect(avisoSoTemplate({ texto: '', templateId: TPL })).toContain('não-oficial')
    expect(avisoSoTemplate({ texto: 'Oi', templateId: TPL })).toBeNull()
    expect(avisoSoTemplate({ texto: '', templateId: '' })).toBeNull()
  })
})
