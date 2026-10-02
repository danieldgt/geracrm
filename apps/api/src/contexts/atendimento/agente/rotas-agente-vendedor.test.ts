import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import type { FastifyInstance } from 'fastify'
import { criarApp } from '../../../app.js'
import { encerrarBanco } from '../../../db/index.js'

/**
 * As rotas NOVAS do vendedor: modo/persona/alçada no PUT, decisões por cursor
 * e o PLAYGROUND (simular) — que fala com o agente real sem WhatsApp.
 */
const T = 'b3d30000-0000-4000-8000-000000000001'
const OUTRO = 'b3d30000-0000-4000-8000-000000000002'
const PV = 'b3d30000-1111-4000-8000-000000000001'
const PV2 = 'b3d30000-1111-4000-8000-000000000002'
const PLANO = 'b3d30000-3333-4000-8000-000000000001'
const MODELO = 'b3d30000-4444-4000-8000-000000000001'
const CANAL = 'b3d30000-7777-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const chamar = (t: string, m: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, corpo?: Record<string, unknown>) =>
  app.inject({ method: m, url, headers: { 'x-tenant-id': t }, ...(corpo ? { payload: corpo } : {}) })

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  process.env.IA_PROVEDOR = 'simulado'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-rotas-vendedor', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-rotas-vendedor', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'A'], [OUTRO, PV2, 'B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado)
             VALUES (${T}, ${CANAL}, 'whatsapp_nao_oficial', 'Loja', 'conectado') ON CONFLICT DO NOTHING`
  app = await criarApp(); await app.ready()
})
afterAll(async () => {
  for (const t of ['agente_decisao', 'agente_sessao', 'agente_tarefa', 'agente_config', 'mensagem', 'conversa', 'contato_identidade_externa', 'contato', 'canal_conectado', 'outbox']) {
    for (const ten of [T, OUTRO]) await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id = '${ten}'`)
  }
  await dono`DELETE FROM tenant WHERE id IN (${T}, ${OUTRO})`
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('Configuração do vendedor', () => {
  it('salva modo, persona, alçada e qualificação, e relê', async () => {
    const r = await chamar(T, 'PUT', `/v1/canais/${CANAL}/agente`, {
      modo: 'sombra', persona: { nome: 'Lia', loja: 'Loja Demo', tom: 'informal', usaEmojis: true },
      alcada: { valorMaxAutonomoCentavos: 50000, efetivaSozinho: true }, qualificacao: ['tipoCompra', 'volume'],
      limiarConfianca: 0.7, orcamentoDiaCentavos: 2000,
    })
    expect(r.statusCode).toBe(200)
    const g = (await chamar(T, 'GET', `/v1/canais/${CANAL}/agente`)).json() as Record<string, unknown>
    expect(g['modo']).toBe('sombra')
    expect(g['ativo']).toBe(true)
    expect(g['persona']).toMatchObject({ nome: 'Lia', loja: 'Loja Demo', tom: 'informal', usaEmojis: true, identificaComoRobo: true })
    expect(g['alcada']).toMatchObject({ valorMaxAutonomoCentavos: 50000, efetivaSozinho: true, descontoMaxPct: 0 })
    expect(g['qualificacao']).toEqual(['tipoCompra', 'volume'])
    expect(g['limiarConfianca']).toBe(0.7)
    expect(g['orcamentoDiaCentavos']).toBe(2000)
  })
  it('sombra sem políticas é permitido; autônomo sem políticas não', async () => {
    expect((await chamar(T, 'PUT', `/v1/canais/${CANAL}/agente`, { modo: 'sombra', politicas: '' })).statusCode).toBe(200)
    const r = await chamar(T, 'PUT', `/v1/canais/${CANAL}/agente`, { modo: 'autonomo', politicas: '' })
    expect(r.statusCode).toBe(422)
    expect((r.json() as { erro: string }).erro).toBe('agente.sem_politicas')
  })
  it('PUT parcial não apaga persona nem alçada', async () => {
    await chamar(T, 'PUT', `/v1/canais/${CANAL}/agente`, { modo: 'sombra', persona: { nome: 'Lia' }, alcada: { valorMaxAutonomoCentavos: 123 } })
    await chamar(T, 'PUT', `/v1/canais/${CANAL}/agente`, { politicas: 'Entrega em 2 dias.' })
    const g = (await chamar(T, 'GET', `/v1/canais/${CANAL}/agente`)).json() as { persona: { nome: string }; alcada: { valorMaxAutonomoCentavos: number } }
    expect(g.persona.nome).toBe('Lia')
    expect(g.alcada.valorMaxAutonomoCentavos).toBe(123)
  })
  it('salvar só as políticas NÃO muda o modo', async () => {
    await chamar(T, 'PUT', `/v1/canais/${CANAL}/agente`, { modo: 'sombra', politicas: 'Entrega em 2 dias.' })
    await chamar(T, 'PUT', `/v1/canais/${CANAL}/agente`, { politicas: 'Entrega em 3 dias.' })
    const g = (await chamar(T, 'GET', `/v1/canais/${CANAL}/agente`)).json() as { modo: string; politicas: string }
    expect(g).toMatchObject({ modo: 'sombra', politicas: 'Entrega em 3 dias.' })
  })
  it('campo fora do contrato é recusado com o nome do campo', async () => {
    const r = await chamar(T, 'PUT', `/v1/canais/${CANAL}/agente`, { modo: 'voando' })
    expect(r.statusCode).toBe(422)
    expect((r.json() as { campos: string[] }).campos).toEqual(['modo'])
  })
})

describe('Playground (simular)', () => {
  it('conversa com o agente sem WhatsApp, grava decisão com modo simulacao e mantém a conversa entre turnos', async () => {
    await chamar(T, 'PUT', `/v1/canais/${CANAL}/agente`, { modo: 'sombra', politicas: 'Entrega em 3 dias úteis.\n\nPagamento por PIX e cartão.' })
    const r1 = await chamar(T, 'POST', `/v1/canais/${CANAL}/agente/simular`, { mensagem: 'oi' })
    expect(r1.statusCode).toBe(200)
    const c1 = r1.json() as { conversaId: string; desfecho: string; mensagens: string[]; rastro: { modelo: string } }
    expect(c1.desfecho).toBe('sugeriu')
    expect(c1.mensagens.length).toBeGreaterThan(0)
    expect(c1.rastro.modelo).toBe('simulado')

    const r2 = await chamar(T, 'POST', `/v1/canais/${CANAL}/agente/simular`, { mensagem: 'qual o prazo de entrega?', conversaId: c1.conversaId })
    const c2 = r2.json() as { conversaId: string; mensagens: string[]; rastro: { chamadas: { nome: string }[] } }
    expect(c2.conversaId).toBe(c1.conversaId)
    expect(c2.rastro.chamadas.map((c) => c.nome)).toContain('conhecimento_buscar')
    expect(c2.mensagens[0]).toMatch(/3 dias/)

    const [n] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM agente_decisao WHERE tenant_id = ${T} AND modo = 'simulacao'`
    expect(n!.n).toBe(2)
    const [at] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM atendimento WHERE tenant_id = ${T}`
    expect(at!.n).toBe(0)

    const d = (await chamar(T, 'GET', `/v1/agente/decisoes?conversaId=${c1.conversaId}`)).json() as { itens: { modo: string; desfecho: string }[] }
    expect(d.itens.length).toBe(2)
    expect(d.itens[0]).toMatchObject({ modo: 'simulacao', desfecho: 'sugeriu' })

    const z = await chamar(T, 'DELETE', `/v1/canais/${CANAL}/agente/simular`)
    expect((z.json() as { mensagensApagadas: number }).mensagensApagadas).toBeGreaterThan(0)
  })
  it('mensagem vazia → 422; canal de outro tenant → 404', async () => {
    expect((await chamar(T, 'POST', `/v1/canais/${CANAL}/agente/simular`, { mensagem: '  ' })).statusCode).toBe(422)
    expect((await chamar(OUTRO, 'POST', `/v1/canais/${CANAL}/agente/simular`, { mensagem: 'oi' })).statusCode).toBe(404)
  })
})

describe('Métricas', () => {
  it('agrega decisões (sem simulação), handoffs por motivo e pedidos do agente', async () => {
    const r = await chamar(T, 'GET', '/v1/agente/metricas?dias=7')
    expect(r.statusCode).toBe(200)
    const m = r.json() as Record<string, unknown>
    expect(m['dias']).toBe(7)
    expect(typeof m['turnos']).toBe('number')
    expect(m['pedidos']).toMatchObject({ propostos: 0, confirmados: 0, efetivados: 0 })
    expect(Array.isArray(m['handoffPorMotivo'])).toBe(true)
    // As decisões do playground (modo simulacao) não contam.
    expect(m['turnos']).toBe(0)
  })
  it('dias fora da faixa é saneado; canalId inválido é ignorado', async () => {
    const m = (await chamar(T, 'GET', '/v1/agente/metricas?dias=999&canalId=xx')).json() as { dias: number; canalId: string | null }
    expect(m.dias).toBe(90)
    expect(m.canalId).toBeNull()
  })
})

describe('Decisões', () => {
  it('outro tenant não enxerga as decisões; cursor inválido → 422', async () => {
    const d = (await chamar(OUTRO, 'GET', '/v1/agente/decisoes')).json() as { itens: unknown[] }
    expect(d.itens).toEqual([])
    expect((await chamar(T, 'GET', '/v1/agente/decisoes?cursor=xxx')).statusCode).toBe(422)
  })
})
