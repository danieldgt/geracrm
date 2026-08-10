import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'

/** NPS — registrar respostas e apurar o score derivado. */
const T = 'de5b0000-0000-4000-8000-000000000001'
const OUTRO = 'de5b0000-0000-4000-8000-000000000002'
const PV = 'de5b0000-1111-4000-8000-000000000001'
const PV2 = 'de5b0000-1111-4000-8000-000000000002'
const PLANO = 'de5b0000-3333-4000-8000-000000000001'
const MODELO = 'de5b0000-4444-4000-8000-000000000001'
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

describe('NPS', () => {
  it('registra resposta; nota fora de 0–10 → 422', async () => {
    expect((await chamar(T, 'POST', '/v1/nps', { nota: 9, contatoId: C1 })).statusCode).toBe(201)
    expect((await chamar(T, 'POST', '/v1/nps', { nota: 11 })).statusCode).toBe(422)
    expect((await chamar(T, 'POST', '/v1/nps', {})).statusCode).toBe(422) // sem nota
  })

  it('⚠️ score derivado = %promotores − %detratores; faixas corretas', async () => {
    // 6 promotores (9-10), 2 neutros (7-8), 2 detratores (0-6) → NPS = 60 − 20 = 40.
    for (const n of [10, 10, 9, 9, 9, 9]) await chamar(T, 'POST', '/v1/nps', { nota: n })
    for (const n of [7, 8]) await chamar(T, 'POST', '/v1/nps', { nota: n })
    for (const n of [3, 6]) await chamar(T, 'POST', '/v1/nps', { nota: n })
    const r = (await chamar(T, 'GET', '/v1/nps?dias=90')).json() as {
      total: number; score: number; distribuicao: { promotores: number; neutros: number; detratores: number }
    }
    expect(r.total).toBe(10)
    expect(r.distribuicao).toEqual({ promotores: 6, neutros: 2, detratores: 2 })
    expect(r.score).toBe(40)
  })

  it('score é null quando não há respostas no período', async () => {
    const r = (await chamar(T, 'GET', '/v1/nps')).json() as { total: number; score: number | null }
    expect(r.total).toBe(0)
    expect(r.score).toBeNull()
  })

  it('lista comentários (só os que têm texto), do mais recente', async () => {
    await chamar(T, 'POST', '/v1/nps', { nota: 10, comentario: 'Excelente atendimento' })
    await chamar(T, 'POST', '/v1/nps', { nota: 3 }) // sem comentário → não aparece
    await chamar(T, 'POST', '/v1/nps', { nota: 5, comentario: 'Demorou a entregar' })
    const r = (await chamar(T, 'GET', '/v1/nps')).json() as { comentarios: { comentario: string; faixa: string }[] }
    expect(r.comentarios.length).toBe(2)
    expect(r.comentarios.map((c) => c.faixa)).toContain('detrator')
    expect(r.comentarios.map((c) => c.faixa)).toContain('promotor')
  })

  it('contato inexistente → 422', async () => {
    expect((await chamar(T, 'POST', '/v1/nps', { nota: 8, contatoId: randomUUID() })).statusCode).toBe(422)
  })

  it('⚠️ isolamento: NPS de um tenant não conta para outro (RLS)', async () => {
    await chamar(OUTRO, 'POST', '/v1/nps', { nota: 10 })
    const r = (await chamar(T, 'GET', '/v1/nps')).json() as { total: number }
    expect(r.total).toBe(0)
  })
})
