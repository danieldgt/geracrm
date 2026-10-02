import { describe, it, expect } from 'vitest'
import { FECHADO, abrir, normalizarPedido, responder } from './confirmacao.estado.js'

const pedido = normalizarPedido({ titulo: 'Excluir meta?', mensagem: 'Não dá para desfazer.', acao: 'Excluir' })

describe('diálogo de confirmação — máquina de estados', () => {
  it('abre com o pedido e sem respostas pendentes', () => {
    const t = abrir(FECHADO, pedido, 1)
    expect(t.estado).toEqual({ aberto: true, pedido, serie: 1 })
    expect(t.respostas).toEqual([])
  })

  it('responder "sim" fecha e entrega true à série aberta', () => {
    const aberto = abrir(FECHADO, pedido, 7).estado
    const t = responder(aberto, true)
    expect(t.estado).toEqual(FECHADO)
    expect(t.respostas).toEqual([{ serie: 7, resposta: true }])
  })

  it('responder "não" (Esc, cancelar, clique fora) entrega false', () => {
    const aberto = abrir(FECHADO, pedido, 2).estado
    expect(responder(aberto, false).respostas).toEqual([{ serie: 2, resposta: false }])
  })

  it('⚠️ abrir um segundo pedido resolve o primeiro como "não" — nenhum await fica pendurado', () => {
    const primeiro = abrir(FECHADO, pedido, 1).estado
    const t = abrir(primeiro, normalizarPedido({ titulo: 'Outro', mensagem: 'x' }), 2)
    expect(t.respostas).toEqual([{ serie: 1, resposta: false }])
    expect(t.estado).toEqual({ aberto: true, serie: 2, pedido: expect.objectContaining({ titulo: 'Outro' }) })
  })

  it('responder com o diálogo fechado é ignorado', () => {
    const t = responder(FECHADO, true)
    expect(t.estado).toBe(FECHADO)
    expect(t.respostas).toEqual([])
  })

  it('normaliza rótulos: vazio vira o padrão, destrutivo por padrão', () => {
    const p = normalizarPedido({ titulo: '  Disparar?  ', mensagem: ' m ', acao: '  ', perigo: false })
    expect(p).toEqual({ titulo: 'Disparar?', mensagem: 'm', acao: 'Confirmar', cancelar: 'Cancelar', perigo: false })
    expect(normalizarPedido({ titulo: 't', mensagem: 'm' }).perigo).toBe(true)
  })
})
