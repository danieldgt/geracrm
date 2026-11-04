import { describe, it, expect } from 'vitest'
import { etapaReuniao, etapaReuniaoPosEnvio, AVISO_REUNIAO_BLOQUEADA } from './reuniao.js'
import { chaveDoTurno, lerReuniaoDoTurno, reuniaoDoTurno } from '../ferramentas/agenda-turno.js'
import type { ContextoPipeline, EntradaPosResposta } from './tipos.js'

/**
 * Etapa `reuniao` isolada (sem banco): com o registro do turno preenchido pela ferramenta, a
 * resposta só passa com horário de fonte; sem registro e com a chave desligada, nem olha.
 * O turno de verdade (pipeline + banco) está em `ferramentas/agenda.test.ts`.
 */
const T = 'c3d10000-0000-4000-8000-000000000001'
let n = 0
function ctx(extra: Record<string, unknown> = {}): ContextoPipeline {
  return {
    tenantId: T, conversaId: `c3d10000-0000-4000-8000-00000000${String(++n).padStart(4, '0')}`, canalId: 'x', contatoId: 'y',
    sessaoId: null, modo: 'autonomo', agora: new Date(Date.now() + n), cfgExtra: extra, persona: {} as never, estado: {},
    historico: [], entrantes: [], primeiraResposta: false, foraDoExpediente: false,
  }
}
const entrada = (mensagens: string[]): EntradaPosResposta => ({
  mensagens, handoff: null, centavosVistos: new Set(), numerosVistos: new Set(), falasAnterioresDoAgente: [],
})

describe('Etapa reuniao (guarda da resposta)', () => {
  it('chave desligada e ferramenta sem uso → não olha (nem consulta o banco)', async () => {
    const r = await etapaReuniao.executar(ctx(), entrada(['Entregamos amanhã às 9h.']))
    expect(r.bloquear).toBeUndefined()
  })

  it('com a ferramenta no turno: oferta montada pelo código passa; hora inventada barra com o texto substituto', async () => {
    const c = ctx()
    const t = reuniaoDoTurno(chaveDoTurno(c.tenantId, c.conversaId, c.agora))
    t.usouFerramenta = true
    t.linhasOfertadas = ['1) qua, 13/03 às 15:00 com Vera']
    t.quandos.push({ data: '2030-03-13', hora: '15:00', diaIso: 3 })
    expect((await etapaReuniao.executar(c, entrada(['Tenho:\n1) qua, 13/03 às 15:00 com Vera', 'Pode ser?']))).bloquear).toBeUndefined()
    const r = await etapaReuniao.executar(c, entrada(['1) qua, 13/03 às 15:00 com Vera', 'ou às 17h']))
    expect(r.bloquear).toMatchObject({ motivo: 'incerteza', mensagensSubstitutas: [AVISO_REUNIAO_BLOQUEADA] })
    expect(r.guardrails.map((g) => `${g.codigo}:${g.gravidade}`)).toEqual(['horario_sem_fonte:CRITICA'])
  })

  it('pós-envio: sem a chave do número não registra efeito; com ela, o efeito descarta o registro do turno', async () => {
    expect(await etapaReuniaoPosEnvio.executar(ctx())).toEqual({ tipo: 'segue' })
    const c = ctx({ agenda_reunioes: true })
    const chave = chaveDoTurno(c.tenantId, c.conversaId, c.agora)
    reuniaoDoTurno(chave).usouFerramenta = true
    const d = await etapaReuniaoPosEnvio.executar(c)
    expect(d.tipo).toBe('segue')
    const efeito = (d as unknown as { efeitos: { executar: (tx: never, r: never) => Promise<unknown[]> }[] }).efeitos[0]!
    expect(await efeito.executar(null as never, { enviadas: [], sessaoId: null } as never)).toEqual([])
    expect(lerReuniaoDoTurno(chave)).toBeNull()
  })
})
