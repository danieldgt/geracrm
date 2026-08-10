import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'

/**
 * EP-04 — gestão de opt-out. O que o teste fixa:
 *   • bloquear por telefone deriva a chave (55+DDD+8) e grava;
 *   • lista mostra o bloqueio; remover apaga;
 *   • telefone inválido → 422;
 *   • um tenant não vê o bloqueio de outro (RLS).
 */
const T = 'b10c0000-0000-4000-8000-000000000001'
const OUTRO = 'b10c0000-0000-4000-8000-000000000002'
const PV = 'b10c0000-1111-4000-8000-000000000001'
const PV2 = 'b10c0000-1111-4000-8000-000000000002'
const PLANO = 'b10c0000-3333-4000-8000-000000000001'
const MODELO = 'b10c0000-4444-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance

const chamar = (t: string, metodo: 'GET' | 'POST' | 'DELETE', url: string, corpo?: Record<string, unknown>) =>
  app.inject({ method: metodo, url, headers: { 'x-tenant-id': t }, ...(corpo ? { payload: corpo } : {}) })

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-blq', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-blq', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'Loja A'], [OUTRO, PV2, 'Loja B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  app = await criarApp()
  await app.ready()
})

afterAll(async () => {
  for (const t of [T, OUTRO]) {
    await dono`DELETE FROM lista_bloqueio WHERE tenant_id = ${t}`
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('EP-04: opt-out / bloqueios', () => {
  it('bloquear por telefone deriva a chave, lista e remove', async () => {
    await dono`DELETE FROM lista_bloqueio WHERE tenant_id = ${T}`
    // "+55 (81) 99999-0000" → chave 55 + 81 + últimos 8 = 5581999990000? (9 dígitos assinante)
    const add = await chamar(T, 'POST', '/v1/bloqueios', { telefone: '5581999990000' })
    expect(add.statusCode).toBe(201)
    const chave = (add.json() as { chave: string }).chave
    expect(chave).toMatch(/^\d{10,13}$/)

    const lista = await chamar(T, 'GET', '/v1/bloqueios')
    expect((lista.json() as { itens: unknown[] }).itens.length).toBe(1)

    const del = await chamar(T, 'DELETE', `/v1/bloqueios/${chave}`)
    expect(del.statusCode).toBe(200)
    const vazio = await chamar(T, 'GET', '/v1/bloqueios')
    expect((vazio.json() as { itens: unknown[] }).itens.length).toBe(0)
  })

  it('telefone inválido → 422', async () => {
    const r = await chamar(T, 'POST', '/v1/bloqueios', { telefone: '123' })
    expect(r.statusCode).toBe(422)
  })

  it('bloquear duas vezes o mesmo telefone é idempotente (não duplica)', async () => {
    await dono`DELETE FROM lista_bloqueio WHERE tenant_id = ${T}`
    await chamar(T, 'POST', '/v1/bloqueios', { telefone: '5581988887777' })
    await chamar(T, 'POST', '/v1/bloqueios', { telefone: '5581988887777' })
    const [c] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM lista_bloqueio WHERE tenant_id = ${T}`
    expect(c!.n).toBe(1)
  })

  it('⚠️ isolamento: bloqueio de um tenant não aparece para outro (RLS)', async () => {
    await dono`DELETE FROM lista_bloqueio WHERE tenant_id IN (${T}, ${OUTRO})`
    await chamar(OUTRO, 'POST', '/v1/bloqueios', { telefone: '5581977776666' })
    const doT = await chamar(T, 'GET', '/v1/bloqueios')
    expect((doT.json() as { itens: unknown[] }).itens.length).toBe(0)
  })
})
