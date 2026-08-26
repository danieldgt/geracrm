import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'

/** Tarefas de follow-up — CRUD + situação derivada. */
const T = 'fa5e0000-0000-4000-8000-000000000001'
const OUTRO = 'fa5e0000-0000-4000-8000-000000000002'
const PV = 'fa5e0000-1111-4000-8000-000000000001'
const PV2 = 'fa5e0000-1111-4000-8000-000000000002'
const PLANO = 'fa5e0000-3333-4000-8000-000000000001'
const MODELO = 'fa5e0000-4444-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const chamar = (t: string, m: 'GET' | 'POST', url: string, corpo?: Record<string, unknown>) =>
  app.inject({ method: m, url, headers: { 'x-tenant-id': t }, ...(corpo ? { payload: corpo } : {}) })

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-ta', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-ta', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'A'], [OUTRO, PV2, 'B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  app = await criarApp(); await app.ready()
})
beforeEach(async () => { await dono`DELETE FROM tarefa WHERE tenant_id IN (${T}, ${OUTRO})` })
afterAll(async () => {
  await dono`DELETE FROM tarefa WHERE tenant_id IN (${T}, ${OUTRO})`
  for (const t of [T, OUTRO]) {
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

const criar = (t: string, venceEm: string, titulo = 'Ligar') =>
  chamar(t, 'POST', '/v1/tarefas', { titulo, venceEm })

describe('Tarefas de follow-up', () => {
  it('cria; título/vencimento obrigatórios', async () => {
    expect((await criar(T, new Date(Date.now() + 86400000).toISOString())).statusCode).toBe(201)
    expect((await chamar(T, 'POST', '/v1/tarefas', { titulo: 'x' })).statusCode).toBe(422) // sem vencimento
    expect((await chamar(T, 'POST', '/v1/tarefas', { venceEm: new Date().toISOString() })).statusCode).toBe(422) // sem título
  })

  it('⚠️ "vencida" é derivada: passado → vencida; futuro → não', async () => {
    await criar(T, new Date(Date.now() - 86400000).toISOString(), 'Atrasada')
    await criar(T, new Date(Date.now() + 86400000).toISOString(), 'Futura')
    const vencidas = await chamar(T, 'GET', '/v1/tarefas?situacao=vencidas')
    const nomes = (vencidas.json() as { itens: { titulo: string; vencida: boolean }[] }).itens
    expect(nomes.length).toBe(1)
    expect(nomes[0]).toMatchObject({ titulo: 'Atrasada', vencida: true })
  })

  it('concluir tira das abertas; concluir de novo → 409', async () => {
    await criar(T, new Date(Date.now() + 86400000).toISOString())
    const [t] = await dono<{ id: string }[]>`SELECT id FROM tarefa WHERE tenant_id=${T} LIMIT 1`
    expect((await chamar(T, 'POST', `/v1/tarefas/${t!.id}/concluir`)).statusCode).toBe(200)
    expect((await chamar(T, 'POST', `/v1/tarefas/${t!.id}/concluir`)).statusCode).toBe(409)
    const abertas = await chamar(T, 'GET', '/v1/tarefas?situacao=abertas')
    expect((abertas.json() as { itens: unknown[] }).itens.length).toBe(0)
    const concluidas = await chamar(T, 'GET', '/v1/tarefas?situacao=concluidas')
    expect((concluidas.json() as { itens: unknown[] }).itens.length).toBe(1)
  })

  it('⚠️ isolamento: tarefa de um tenant não aparece para outro (RLS)', async () => {
    await criar(OUTRO, new Date(Date.now() + 86400000).toISOString())
    expect((await chamar(T, 'GET', '/v1/tarefas').then((r) => (r.json() as { itens: unknown[] }).itens.length))).toBe(0)
  })
})
