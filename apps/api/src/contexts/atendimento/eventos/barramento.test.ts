import { describe, it, expect } from 'vitest'
import { assinar, despacharParaTeste, type EventoCliente } from './barramento.js'

/**
 * Testes de defesa em profundidade do tempo real (skill geracrm-tempo-real).
 * ⚠️ Aqui mora o risco de vazar conversa entre empresas — estes testes existem
 * para tornar isso impossível de passar despercebido.
 */
const A = 'aaaa0000-0000-4000-8000-000000000001'
const B = 'bbbb0000-0000-4000-8000-000000000002'

describe('barramento — isolamento por tenant', () => {
  it('⚠️ evento de um tenant NÃO chega a assinante de outro tenant', () => {
    const recebidosA: EventoCliente[] = []
    const recebidosB: EventoCliente[] = []
    const offA = assinar(A, (e) => recebidosA.push(e))
    const offB = assinar(B, (e) => recebidosB.push(e))

    despacharParaTeste({ tenantId: A, id: 1, tipo: 'mensagem.recebida', conversaId: 'c-a', versao: 3 })

    expect(recebidosA).toHaveLength(1)
    expect(recebidosB).toHaveLength(0) // ⚠️ o de B NÃO pode ver
    offA()
    offB()
  })

  it('⚠️ o evento entregue NÃO carrega tenantId nem conteúdo — só ids', () => {
    let recebido: EventoCliente | null = null
    const off = assinar(A, (e) => (recebido = e))
    despacharParaTeste({ tenantId: A, id: 7, tipo: 'mensagem.recebida', conversaId: 'c-1', versao: 9 })
    off()

    expect(recebido).toEqual({ id: 7, tipo: 'mensagem.recebida', conversaId: 'c-1', versao: 9 })
    // Nem tenantId, nem texto, nem qualquer conteúdo.
    expect(JSON.stringify(recebido)).not.toContain('tenantId')
    expect(JSON.stringify(recebido)).not.toMatch(/texto|message|conteudo/i)
  })

  it('cancelar a assinatura para de entregar', () => {
    const recebidos: EventoCliente[] = []
    const off = assinar(A, (e) => recebidos.push(e))
    despacharParaTeste({ tenantId: A, id: 1, tipo: 'x' })
    off()
    despacharParaTeste({ tenantId: A, id: 2, tipo: 'x' })
    expect(recebidos.map((e) => e.id)).toEqual([1]) // o 2 não chega
  })

  it('múltiplas abas do mesmo tenant recebem todas', () => {
    const aba1: number[] = []
    const aba2: number[] = []
    const off1 = assinar(A, (e) => aba1.push(e.id))
    const off2 = assinar(A, (e) => aba2.push(e.id))
    despacharParaTeste({ tenantId: A, id: 42, tipo: 'x' })
    off1()
    off2()
    expect([aba1, aba2]).toEqual([[42], [42]])
  })
})
