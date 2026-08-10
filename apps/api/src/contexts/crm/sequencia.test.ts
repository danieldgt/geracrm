import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'

/** Sequências (régua) — CRUD + aplicar materializa tarefas. */
const T = 'de5c0000-0000-4000-8000-000000000001'
const OUTRO = 'de5c0000-0000-4000-8000-000000000002'
const PV = 'de5c0000-1111-4000-8000-000000000001'
const PV2 = 'de5c0000-1111-4000-8000-000000000002'
const PLANO = 'de5c0000-3333-4000-8000-000000000001'
const MODELO = 'de5c0000-4444-4000-8000-000000000001'
const C1 = 'de5c0000-6666-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const chamar = (t: string, m: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, corpo?: Record<string, unknown>) =>
  app.inject({ method: m, url, headers: { 'x-tenant-id': t }, ...(corpo ? { payload: corpo } : {}) })

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-sq', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-sq', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'A'], [OUTRO, PV2, 'B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES (${T}, ${C1}, 'Cliente Seq', 'teste', true) ON CONFLICT DO NOTHING`
  app = await criarApp(); await app.ready()
})

beforeEach(async () => {
  await dono`DELETE FROM sequencia WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM tarefa WHERE tenant_id IN (${T}, ${OUTRO})`
})

afterAll(async () => {
  await dono`DELETE FROM sequencia WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM tarefa WHERE tenant_id IN (${T}, ${OUTRO})`
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

async function criarSeq(t: string, nome = 'Pós-venda'): Promise<string> {
  return (await chamar(t, 'POST', '/v1/sequencias', { nome }).then((r) => r.json())).id
}

describe('Sequências (régua de relacionamento)', () => {
  it('cria; nome obrigatório; nome duplicado → 409', async () => {
    expect((await chamar(T, 'POST', '/v1/sequencias', { nome: 'Pós-venda' })).statusCode).toBe(201)
    expect((await chamar(T, 'POST', '/v1/sequencias', {})).statusCode).toBe(422)
    expect((await chamar(T, 'POST', '/v1/sequencias', { nome: 'pós-venda' })).statusCode).toBe(409)
  })

  it('adiciona passos; offset negativo → 422; lista ordenada por D+N', async () => {
    const id = await criarSeq(T)
    expect((await chamar(T, 'POST', `/v1/sequencias/${id}/passos`, { offsetDias: 7, titulo: 'Verificar recebimento' })).statusCode).toBe(201)
    expect((await chamar(T, 'POST', `/v1/sequencias/${id}/passos`, { offsetDias: 0, titulo: 'Agradecer a compra' })).statusCode).toBe(201)
    expect((await chamar(T, 'POST', `/v1/sequencias/${id}/passos`, { offsetDias: -1, titulo: 'x' })).statusCode).toBe(422)
    const r = (await chamar(T, 'GET', `/v1/sequencias/${id}/passos`)).json() as { itens: { offsetDias: number; titulo: string }[] }
    expect(r.itens.map((p) => p.offsetDias)).toEqual([0, 7]) // ordenado por D+N
  })

  it('⚠️ aplicar a um contato materializa uma tarefa por passo, com vencimento = hoje + offset', async () => {
    const id = await criarSeq(T)
    await chamar(T, 'POST', `/v1/sequencias/${id}/passos`, { offsetDias: 0, titulo: 'Agradecer' })
    await chamar(T, 'POST', `/v1/sequencias/${id}/passos`, { offsetDias: 7, titulo: 'Verificar' })
    const ap = await chamar(T, 'POST', `/v1/sequencias/${id}/aplicar`, { contatoId: C1 })
    expect(ap.statusCode).toBe(200)
    expect((ap.json() as { tarefasCriadas: number }).tarefasCriadas).toBe(2)

    const tarefas = await dono<{ titulo: string; dias: number }[]>`
      SELECT titulo, (vence_em::date - now()::date) AS dias
        FROM tarefa WHERE tenant_id = ${T} AND contato_id = ${C1} ORDER BY vence_em ASC`
    expect(tarefas.length).toBe(2)
    expect(tarefas[0]).toMatchObject({ titulo: 'Agradecer', dias: 0 })
    expect(tarefas[1]).toMatchObject({ titulo: 'Verificar', dias: 7 })
  })

  it('aplicar com contato inexistente → 422; sequência inexistente → 404', async () => {
    const id = await criarSeq(T)
    expect((await chamar(T, 'POST', `/v1/sequencias/${id}/aplicar`, { contatoId: '00000000-0000-4000-8000-000000000000' })).statusCode).toBe(422)
    expect((await chamar(T, 'POST', `/v1/sequencias/00000000-0000-4000-8000-0000000000ff/aplicar`, { contatoId: C1 })).statusCode).toBe(404)
  })

  it('⚠️ isolamento: sequência de um tenant não aparece para outro (RLS)', async () => {
    await criarSeq(OUTRO)
    const r = (await chamar(T, 'GET', '/v1/sequencias')).json() as { itens: unknown[] }
    expect(r.itens.length).toBe(0)
  })
})
