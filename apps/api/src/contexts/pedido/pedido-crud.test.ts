import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'

/** Expansão de CRUDs — lista e gestão do pedido (rascunho). */
const T = 'ce0d0000-0000-4000-8000-000000000001'
const PV = 'ce0d0000-1111-4000-8000-000000000001'
const PLANO = 'ce0d0000-3333-4000-8000-000000000001'
const MODELO = 'ce0d0000-4444-4000-8000-000000000001'
const CONTATO = 'ce0d0000-6666-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const chamar = (m: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, corpo?: Record<string, unknown>) =>
  app.inject({ method: m, url, headers: { 'x-tenant-id': T }, ...(corpo ? { payload: corpo } : {}) })

async function rascunhoComItem(qtd = 2, valor = 5000): Promise<string> {
  const id = randomUUID()
  await dono`INSERT INTO pedido (tenant_id, id, contato_id, estado) VALUES (${T}, ${id}, ${CONTATO}, 'rascunho')`
  await dono`INSERT INTO pedido_item (tenant_id, pedido_id, seq, sku_snapshot, descricao_snapshot, quantidade, valor_unitario_centavos)
             VALUES (${T}, ${id}, 1, 'SKU-1', 'Camisa', ${qtd}, ${valor})`
  await dono`UPDATE pedido SET total_centavos = ${qtd * valor}, total_pecas = ${qtd} WHERE tenant_id=${T} AND id=${id}`
  return id
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-pc', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-pc', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'Loja PC', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES (${T}, ${CONTATO}, 'Cliente', 'teste', true) ON CONFLICT DO NOTHING`
  app = await criarApp(); await app.ready()
})

beforeEach(async () => {
  await dono`DELETE FROM pedido_item WHERE tenant_id = ${T}`
  await dono`DELETE FROM pedido WHERE tenant_id = ${T}`
})

afterAll(async () => {
  await dono`DELETE FROM pedido_item WHERE tenant_id = ${T}`
  await dono`DELETE FROM pedido WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato WHERE tenant_id = ${T}`
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${T}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${T}`
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('CRUD do pedido', () => {
  it('lista pedidos filtrando por estado', async () => {
    await rascunhoComItem()
    const efet = await rascunhoComItem()
    await dono`UPDATE pedido SET estado='efetivado' WHERE tenant_id=${T} AND id=${efet}`
    const rascunhos = await chamar('GET', '/v1/pedidos?estado=rascunho')
    expect((rascunhos.json() as { itens: unknown[] }).itens.length).toBe(1)
    const todos = await chamar('GET', '/v1/pedidos')
    expect((todos.json() as { itens: unknown[] }).itens.length).toBe(2)
  })

  it('altera a quantidade do item e recalcula o total', async () => {
    const id = await rascunhoComItem(2, 5000) // total 10000
    const r = await chamar('PATCH', `/v1/pedidos/${id}/itens/1`, { quantidade: 5 })
    expect(r.statusCode).toBe(200)
    const [p] = await dono<{ total: string; pecas: string }[]>`SELECT total_centavos::text AS total, total_pecas::text AS pecas FROM pedido WHERE tenant_id=${T} AND id=${id}`
    expect(Number(p!.total)).toBe(25000) // 5 × 5000
    expect(Number(p!.pecas)).toBe(5)
  })

  it('quantidade <= 0 → 422', async () => {
    const id = await rascunhoComItem()
    expect((await chamar('PATCH', `/v1/pedidos/${id}/itens/1`, { quantidade: 0 })).statusCode).toBe(422)
  })

  it('remove item e recalcula (zera)', async () => {
    const id = await rascunhoComItem()
    const r = await chamar('DELETE', `/v1/pedidos/${id}/itens/1`)
    expect(r.statusCode).toBe(200)
    const [p] = await dono<{ total: string }[]>`SELECT total_centavos::text AS total FROM pedido WHERE tenant_id=${T} AND id=${id}`
    expect(Number(p!.total)).toBe(0)
  })

  it('⚠️ não altera item de pedido efetivado (imutável) → 409', async () => {
    const id = await rascunhoComItem()
    await dono`UPDATE pedido SET estado='efetivado' WHERE tenant_id=${T} AND id=${id}`
    expect((await chamar('PATCH', `/v1/pedidos/${id}/itens/1`, { quantidade: 3 })).statusCode).toBe(409)
  })

  it('cancela rascunho; efetivado não é cancelável → 409', async () => {
    const id = await rascunhoComItem()
    expect((await chamar('POST', `/v1/pedidos/${id}/cancelar`)).statusCode).toBe(200)
    expect((await dono<{ estado: string }[]>`SELECT estado FROM pedido WHERE tenant_id=${T} AND id=${id}`)[0]!.estado).toBe('cancelado')
    const efet = await rascunhoComItem()
    await dono`UPDATE pedido SET estado='efetivado' WHERE tenant_id=${T} AND id=${efet}`
    expect((await chamar('POST', `/v1/pedidos/${efet}/cancelar`)).statusCode).toBe(409)
  })
})
