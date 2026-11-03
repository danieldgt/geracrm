import { describe, it, expect } from 'vitest'
import { PIPELINE_PADRAO, montarPipeline, rodarPreLlm, type ContextoPipeline } from './index.js'
import { etapaPosVenda } from './pos-venda.js'
import { lerRoteiroPosVenda, npsAberto, roteiroVigente } from '../pos-venda.js'

/**
 * Etapa `pos-venda` (G3): lê o roteiro aberto pela ativa de pós-venda e só
 * ACRESCENTA instrução — depois da devolução, antes do modelo. Puro (sem banco).
 */
const AGORA = new Date('2026-10-20T15:00:00Z')
const ctxCom = (estado: Record<string, unknown>, sessaoId: string | null = 's1', agora = AGORA) =>
  ({ estado, sessaoId, modo: 'autonomo', agora, entrantes: [], historico: [] }) as unknown as ContextoPipeline
const nps = { posVenda: { roteiro: 'nps', pedidoId: 'p1', em: '2026-10-20T12:00:00Z' } }

describe('Etapa pos-venda', () => {
  it('está no pipeline padrão, DEPOIS da devolução, e só acrescenta instrução', async () => {
    expect(PIPELINE_PADRAO.posVenda).toBe(etapaPosVenda)
    const r = await rodarPreLlm(montarPipeline({
      gatilhos: { nome: 'g', executar: async () => ({ tipo: 'segue' }) },
      slots: { nome: 's', executar: async () => ({ tipo: 'segue' }) },
      teto: { ...PIPELINE_PADRAO.teto, antes: async () => ({ tipo: 'segue' }) },
      devolucao: { nome: 'd', executar: async () => ({ tipo: 'segue', instrucoes: ['da devolução'] }) },
    }), ctxCom(nps))
    expect(r.decisao).toEqual({ tipo: 'segue' })
    expect(r.instrucoes[0]).toBe('da devolução')
    expect(r.instrucoes[1]).toContain('registrar_nps')
    expect(r.estado).toEqual({})
    expect(r.efeitos).toEqual([])
  })

  it('quem barra antes (teto) não deixa a instrução chegar', async () => {
    const r = await rodarPreLlm(montarPipeline({
      gatilhos: { nome: 'g', executar: async () => ({ tipo: 'segue' }) },
      slots: { nome: 's', executar: async () => ({ tipo: 'segue' }) },
      teto: { ...PIPELINE_PADRAO.teto, antes: async () => ({ tipo: 'silencio', motivo: 'teto' }) },
    }), ctxCom(nps))
    expect(r.instrucoes.join()).not.toContain('registrar_nps')
  })

  it('indicação orienta registrar_indicacoes; agradecimento não acrescenta nada; NPS já registrado não pede de novo', async () => {
    const ind = await etapaPosVenda.executar(ctxCom({ posVenda: { ...nps.posVenda, roteiro: 'indicacao' } }))
    expect(ind).toMatchObject({ tipo: 'segue', instrucoes: [expect.stringContaining('registrar_indicacoes')] })
    expect(await etapaPosVenda.executar(ctxCom({ posVenda: { ...nps.posVenda, roteiro: 'agradecimento' } }))).toEqual({ tipo: 'segue' })
    const feito = await etapaPosVenda.executar(ctxCom({ posVenda: { ...nps.posVenda, npsRegistradoEm: '2026-10-20T13:00:00Z' } }))
    expect(feito).toMatchObject({ instrucoes: [expect.stringContaining('não pergunte de novo')] })
  })

  it('sem sessão, sem roteiro, malformado ou vencido (> 7 dias): segue sem instrução', async () => {
    const vencido = new Date('2026-10-28T13:00:00Z')
    for (const ctx of [ctxCom(nps, null), ctxCom({}), ctxCom({ posVenda: { roteiro: 'cupom', pedidoId: 'p', em: 'x' } }), ctxCom(nps, 's1', vencido)]) {
      expect(await etapaPosVenda.executar(ctx)).toEqual({ tipo: 'segue' })
    }
  })

  it('regras do roteiro: vigência e NPS aberto', () => {
    const r = lerRoteiroPosVenda(nps.posVenda)
    expect(roteiroVigente(r, AGORA)).toBe(true)
    expect(npsAberto(r, AGORA)).toBe(true)
    expect(npsAberto(lerRoteiroPosVenda({ ...nps.posVenda, npsRegistradoEm: '2026-10-20T13:00:00Z' }), AGORA)).toBe(false)
    expect(npsAberto(lerRoteiroPosVenda({ ...nps.posVenda, roteiro: 'indicacao' }), AGORA)).toBe(false)
    expect(roteiroVigente(r, new Date('2026-10-20T11:00:00Z'))).toBe(false) // antes do envio
  })
})
