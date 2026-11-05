import { describe, it, expect } from 'vitest'
import { PIPELINE_PADRAO, montarPipeline, rodarPreLlm, type ContextoPipeline } from './index.js'
import { etapaPosVenda } from './pos-venda.js'
import { indicacaoAberta, lerPosVenda, npsAberto, posVendaPendente, roteiroVigente } from '../pos-venda.js'
import { portaoDoAgente, type ContextoPortao } from '../portao.js'

/**
 * Etapa `pos-venda` (G3): lê os roteiros abertos pela ativa de pós-venda e só
 * ACRESCENTA instrução — depois da devolução, antes do modelo. Mais as regras
 * puras dos roteiros e a exceção do portão. Puro (sem banco).
 */
const AGORA = new Date('2026-10-20T15:00:00Z')
const ctxCom = (estado: Record<string, unknown>, sessaoId: string | null = 's1', agora = AGORA) =>
  ({ estado, sessaoId, modo: 'autonomo', agora, entrantes: [], historico: [] }) as unknown as ContextoPipeline
const NPS = { pedidoId: 'p1', em: '2026-10-20T12:00:00Z' }
const IND = { pedidoId: 'p1', em: '2026-10-20T12:00:00Z', registradas: 0 }
const nps = { posVenda: { nps: NPS } }

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

  it('NPS e indicação ao mesmo tempo: duas instruções; indicação no teto manda parar; NPS registrado não pede de novo', async () => {
    const ambos = await etapaPosVenda.executar(ctxCom({ posVenda: { nps: NPS, indicacao: IND } }))
    expect(ambos).toMatchObject({ tipo: 'segue', instrucoes: [expect.stringContaining('registrar_nps'), expect.stringContaining('registrar_indicacoes')] })
    const cheia = await etapaPosVenda.executar(ctxCom({ posVenda: { indicacao: { ...IND, registradas: 5 } } }))
    expect(cheia).toMatchObject({ instrucoes: [expect.stringContaining('limite')] })
    const feito = await etapaPosVenda.executar(ctxCom({ posVenda: { nps: { ...NPS, npsRegistradoEm: '2026-10-20T13:00:00Z' } } }))
    expect(feito).toMatchObject({ instrucoes: [expect.stringContaining('não pergunte de novo')] })
  })

  it('sem sessão, sem roteiro, malformado ou vencido (> 7 dias): segue sem instrução', async () => {
    const vencido = new Date('2026-10-28T13:00:00Z')
    for (const ctx of [ctxCom(nps, null), ctxCom({}), ctxCom({ posVenda: { nps: { pedidoId: 'p', em: 'x' } } }), ctxCom(nps, 's1', vencido)]) {
      expect(await etapaPosVenda.executar(ctx)).toEqual({ tipo: 'segue' })
    }
  })
})

describe('Roteiros na sessão (regras puras)', () => {
  it('vigência, NPS aberto, indicação aberta com teto, pendência', () => {
    const pv = lerPosVenda({ nps: NPS, indicacao: IND })
    expect(roteiroVigente(pv.nps, AGORA)).toBe(true)
    expect(roteiroVigente(pv.nps, new Date('2026-10-20T11:00:00Z'))).toBe(false) // antes do envio
    expect(npsAberto(pv, AGORA)).toBe(true)
    expect(indicacaoAberta(pv, AGORA)).toBe(true)
    expect(indicacaoAberta(lerPosVenda({ indicacao: { ...IND, registradas: 5 } }), AGORA)).toBe(false)
    expect(posVendaPendente(lerPosVenda({ nps: { ...NPS, npsRegistradoEm: 'x' } }), AGORA)).toBe(false)
    expect(posVendaPendente(lerPosVenda({}), AGORA)).toBe(false)
  })
  it('⚠️ B3: os roteiros são independentes — indicação não apaga NPS pendente', () => {
    const pv = lerPosVenda({ nps: NPS, indicacao: IND })
    expect(npsAberto(pv, AGORA) && indicacaoAberta(pv, AGORA)).toBe(true)
  })
  it('formato antigo achatado ainda é lido como o roteiro que diz ser', () => {
    expect(npsAberto(lerPosVenda({ roteiro: 'nps', ...NPS }), AGORA)).toBe(true)
    expect(lerPosVenda({ roteiro: 'agradecimento', ...NPS })).toEqual({ nps: null, indicacao: null })
  })
})

describe('Portão com pós-venda pendente (A3)', () => {
  const base: ContextoPortao = {
    agenteAtivo: true, ninguemDisponivel: false, ausenciaJaEnviada: false, atendentePresente: false,
    sessaoAtiva: { turnos: 0 }, sessaoEncerrada: null, maxTurnos: 10,
    regras: { soQuandoNinguemDisponivel: true, exigirAusenciaAntes: true, reabrirAposEncerrada: false, horasParaReabrir: 12 },
  }
  it('equipe disponível: sem pós-venda pendente quem atende é gente; com pendente, o agente entra', () => {
    expect(portaoDoAgente(base)).toEqual({ entra: false, motivo: 'tem_quem_atenda' })
    expect(portaoDoAgente({ ...base, posVendaPendente: true })).toEqual({ entra: true, sessao: 'continua' })
  })
  it('⚠️ atendente presente e agente desligado continuam vencendo', () => {
    expect(portaoDoAgente({ ...base, posVendaPendente: true, atendentePresente: true })).toEqual({ entra: false, motivo: 'atendente_presente' })
    expect(portaoDoAgente({ ...base, posVendaPendente: true, agenteAtivo: false })).toEqual({ entra: false, motivo: 'agente_desligado' })
  })
})
