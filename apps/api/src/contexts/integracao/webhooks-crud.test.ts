import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'

/**
 * INT-07 — gestão de webhooks de saída. Fixa: só HTTPS, segredo devolvido UMA
 * vez (a lista nunca vaza), cursor nasce no topo do outbox (sem inundar de
 * histórico), e isolamento por tenant.
 */
const T = 'e07c0000-0000-4000-8000-000000000001'
const OUTRO = 'e07c0000-0000-4000-8000-000000000002'
const PV = 'e07c0000-1111-4000-8000-000000000001'
const PV2 = 'e07c0000-1111-4000-8000-000000000002'
const PLANO = 'e07c0000-3333-4000-8000-000000000001'
const MODELO = 'e07c0000-4444-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const chamar = (t: string, m: 'GET' | 'POST' | 'DELETE', url: string, corpo?: Record<string, unknown>) =>
  app.inject({ method: m, url, headers: { 'x-tenant-id': t }, ...(corpo ? { payload: corpo } : {}) })

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-wc', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-wc', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'A'], [OUTRO, PV2, 'B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  // Um evento no outbox de T, para o cursor nascer > 0.
  await dono`INSERT INTO outbox (tenant_id, tipo, agregado, payload) VALUES (${T}, 'x', 'conversa', '{}'::jsonb)`
  app = await criarApp(); await app.ready()
})

afterAll(async () => {
  for (const t of [T, OUTRO]) {
    await dono`DELETE FROM webhook_saida WHERE tenant_id = ${t}`
    await dono`DELETE FROM outbox WHERE tenant_id = ${t}`
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('INT-07: CRUD de webhooks de saída', () => {
  it('rejeita URL não-https (payload vaza em HTTP)', async () => {
    expect((await chamar(T, 'POST', '/v1/webhooks', { url: 'http://ex/h' })).statusCode).toBe(422)
    expect((await chamar(T, 'POST', '/v1/webhooks', { url: 'não é url' })).statusCode).toBe(422)
  })

  it('cria devolvendo o segredo UMA vez; cursor nasce no topo do outbox', async () => {
    await dono`DELETE FROM webhook_saida WHERE tenant_id = ${T}`
    const r = await chamar(T, 'POST', '/v1/webhooks', { url: 'https://ex/hook', eventos: ['mensagem.recebida'] })
    expect(r.statusCode).toBe(201)
    const body = r.json() as { id: string; segredo: string }
    expect(body.segredo).toMatch(/^[0-9a-f]{48}$/)
    const [w] = await dono<{ cursor: string }[]>`SELECT cursor::text FROM webhook_saida WHERE tenant_id = ${T} AND id = ${body.id}`
    expect(Number(w!.cursor)).toBeGreaterThan(0) // não começa em 0 → não pega histórico
  })

  it('⚠️ a lista NUNCA devolve o segredo', async () => {
    const r = await chamar(T, 'GET', '/v1/webhooks')
    expect(r.body).not.toContain('segredo')
    expect(JSON.stringify(r.json())).not.toMatch(/[0-9a-f]{48}/)
  })

  it('⚠️ isolamento: um tenant não vê o webhook do outro (RLS)', async () => {
    await chamar(OUTRO, 'POST', '/v1/webhooks', { url: 'https://b/hook' })
    const doT = await chamar(T, 'GET', '/v1/webhooks')
    const urls = (doT.json() as { itens: { url: string }[] }).itens.map((i) => i.url)
    expect(urls).not.toContain('https://b/hook')
  })
})
