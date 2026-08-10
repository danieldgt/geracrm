import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'

/** NPS pós-atendimento — score DERIVADO, agrupado POR ATENDENTE. */
const T = 'de5b0000-0000-4000-8000-000000000001'
const OUTRO = 'de5b0000-0000-4000-8000-000000000002'
const PV = 'de5b0000-1111-4000-8000-000000000001'
const PV2 = 'de5b0000-1111-4000-8000-000000000002'
const PLANO = 'de5b0000-3333-4000-8000-000000000001'
const MODELO = 'de5b0000-4444-4000-8000-000000000001'
const VEND_A = 'de5b0000-5555-4000-8000-000000000001'
const VEND_B = 'de5b0000-5555-4000-8000-000000000002'
const C1 = 'de5b0000-6666-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const chamar = (t: string, m: 'GET' | 'POST', url: string, corpo?: Record<string, unknown>) =>
  app.inject({ method: m, url, headers: { 'x-tenant-id': t }, ...(corpo ? { payload: corpo } : {}) })

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-np', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-np', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'A'], [OUTRO, PV2, 'B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${T}, ${VEND_A}, ${'sub-' + VEND_A}, 'Ana', 'ana@ex.com') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${T}, ${VEND_B}, ${'sub-' + VEND_B}, 'Bruno', 'bruno@ex.com') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES (${T}, ${C1}, 'Cliente NPS', 'teste', true) ON CONFLICT DO NOTHING`
  app = await criarApp(); await app.ready()
})

beforeEach(async () => { await dono`DELETE FROM nps_resposta WHERE tenant_id IN (${T}, ${OUTRO})` })

afterAll(async () => {
  await dono`DELETE FROM nps_resposta WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM contato WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM usuario WHERE tenant_id IN (${T}, ${OUTRO})`
  for (const t of [T, OUTRO]) {
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('NPS por atendente', () => {
  it('registra resposta; nota fora de 0–10 → 422', async () => {
    expect((await chamar(T, 'POST', '/v1/nps', { nota: 9, atendenteId: VEND_A })).statusCode).toBe(201)
    expect((await chamar(T, 'POST', '/v1/nps', { nota: 11 })).statusCode).toBe(422)
    expect((await chamar(T, 'POST', '/v1/nps', {})).statusCode).toBe(422)
  })

  it('⚠️ score é derivado e agrupado por atendente', async () => {
    // Ana: 3 promotores + 1 detrator → NPS = 75 − 25 = 50 (4 respostas).
    for (const n of [10, 9, 9]) await chamar(T, 'POST', '/v1/nps', { nota: n, atendenteId: VEND_A })
    await chamar(T, 'POST', '/v1/nps', { nota: 4, atendenteId: VEND_A })
    // Bruno: 1 promotor + 1 neutro → NPS = 50 − 0 = 50 (2 respostas).
    await chamar(T, 'POST', '/v1/nps', { nota: 10, atendenteId: VEND_B })
    await chamar(T, 'POST', '/v1/nps', { nota: 8, atendenteId: VEND_B })

    const r = (await chamar(T, 'GET', '/v1/nps?dias=90')).json() as {
      geral: { total: number; score: number }
      porAtendente: { usuarioId: string; nome: string; total: number; score: number; promotores: number; detratores: number }[]
    }
    expect(r.geral.total).toBe(6)
    const ana = r.porAtendente.find((a) => a.usuarioId === VEND_A)
    const bruno = r.porAtendente.find((a) => a.usuarioId === VEND_B)
    expect(ana).toMatchObject({ nome: 'Ana', total: 4, promotores: 3, detratores: 1, score: 50 })
    expect(bruno).toMatchObject({ nome: 'Bruno', total: 2, score: 50 })
    // Ordenado por nº de respostas: Ana (4) antes de Bruno (2).
    expect(r.porAtendente[0]!.usuarioId).toBe(VEND_A)
  })

  it('geral score é null quando não há respostas', async () => {
    const r = (await chamar(T, 'GET', '/v1/nps')).json() as { geral: { total: number; score: number | null }; porAtendente: unknown[] }
    expect(r.geral.total).toBe(0)
    expect(r.geral.score).toBeNull()
    expect(r.porAtendente.length).toBe(0)
  })

  it('atendente inexistente → 422', async () => {
    expect((await chamar(T, 'POST', '/v1/nps', { nota: 8, atendenteId: randomUUID() })).statusCode).toBe(422)
  })

  it('⚠️ isolamento: NPS de um tenant não conta para outro (RLS)', async () => {
    await chamar(OUTRO, 'POST', '/v1/nps', { nota: 10 })
    const r = (await chamar(T, 'GET', '/v1/nps')).json() as { geral: { total: number } }
    expect(r.geral.total).toBe(0)
  })
})
