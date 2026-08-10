import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'

/** Listas (públicos salvos) — CRUD + membros + unicidade + isolamento. */
const T = 'fa5a0000-0000-4000-8000-000000000001'
const OUTRO = 'fa5a0000-0000-4000-8000-000000000002'
const PV = 'fa5a0000-1111-4000-8000-000000000001'
const PV2 = 'fa5a0000-1111-4000-8000-000000000002'
const PLANO = 'fa5a0000-3333-4000-8000-000000000001'
const MODELO = 'fa5a0000-4444-4000-8000-000000000001'
const C1 = 'fa5a0000-6666-4000-8000-000000000001'
const C2 = 'fa5a0000-6666-4000-8000-000000000002'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const chamar = (t: string, m: 'GET' | 'POST' | 'DELETE', url: string, corpo?: Record<string, unknown>) =>
  app.inject({ method: m, url, headers: { 'x-tenant-id': t }, ...(corpo ? { payload: corpo } : {}) })

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-li', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-li', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'A'], [OUTRO, PV2, 'B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES (${T}, ${C1}, 'Alfa', 'teste', true) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES (${T}, ${C2}, 'Beta', 'teste', true) ON CONFLICT DO NOTHING`
  app = await criarApp(); await app.ready()
})

beforeEach(async () => { await dono`DELETE FROM lista WHERE tenant_id IN (${T}, ${OUTRO})` })

afterAll(async () => {
  await dono`DELETE FROM lista WHERE tenant_id IN (${T}, ${OUTRO})`
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

async function criarLista(t: string, nome = 'VIP'): Promise<string> {
  const r = await chamar(t, 'POST', '/v1/listas', { nome })
  return (r.json() as { id: string }).id
}

describe('Listas (públicos salvos)', () => {
  it('cria; nome obrigatório; nome duplicado → 409', async () => {
    expect((await chamar(T, 'POST', '/v1/listas', { nome: 'VIP' })).statusCode).toBe(201)
    expect((await chamar(T, 'POST', '/v1/listas', {})).statusCode).toBe(422)
    expect((await chamar(T, 'POST', '/v1/listas', { nome: 'vip' })).statusCode).toBe(409) // case-insensitive
  })

  it('adiciona membro (idempotente) e conta; remover funciona', async () => {
    const id = await criarLista(T)
    expect((await chamar(T, 'POST', `/v1/listas/${id}/membros`, { contatoId: C1 })).statusCode).toBe(201)
    expect((await chamar(T, 'POST', `/v1/listas/${id}/membros`, { contatoId: C1 })).statusCode).toBe(201) // idempotente
    await chamar(T, 'POST', `/v1/listas/${id}/membros`, { contatoId: C2 })

    const listas = (await chamar(T, 'GET', '/v1/listas')).json() as { itens: { id: string; membros: number }[] }
    expect(listas.itens.find((l) => l.id === id)?.membros).toBe(2)

    const membros = (await chamar(T, 'GET', `/v1/listas/${id}/membros`)).json() as { itens: { id: string; nome: string }[] }
    expect(membros.itens.map((m) => m.nome)).toEqual(['Alfa', 'Beta'])

    expect((await chamar(T, 'DELETE', `/v1/listas/${id}/membros/${C1}`)).statusCode).toBe(200)
    const depois = (await chamar(T, 'GET', `/v1/listas/${id}/membros`)).json() as { itens: unknown[] }
    expect(depois.itens.length).toBe(1)
  })

  it('adicionar contato inexistente → 422; lista inexistente → 404', async () => {
    const id = await criarLista(T)
    expect((await chamar(T, 'POST', `/v1/listas/${id}/membros`, { contatoId: randomUUID() })).statusCode).toBe(422)
    expect((await chamar(T, 'POST', `/v1/listas/${randomUUID()}/membros`, { contatoId: C1 })).statusCode).toBe(404)
  })

  it('excluir a lista leva os membros junto (cascade)', async () => {
    const id = await criarLista(T)
    await chamar(T, 'POST', `/v1/listas/${id}/membros`, { contatoId: C1 })
    expect((await chamar(T, 'DELETE', `/v1/listas/${id}`)).statusCode).toBe(200)
    const [n] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM lista_membro WHERE tenant_id=${T} AND lista_id=${id}`
    expect(n!.n).toBe(0)
  })

  it('⚠️ isolamento: lista de um tenant não aparece para outro (RLS)', async () => {
    await criarLista(OUTRO)
    const r = (await chamar(T, 'GET', '/v1/listas')).json() as { itens: unknown[] }
    expect(r.itens.length).toBe(0)
  })
})
