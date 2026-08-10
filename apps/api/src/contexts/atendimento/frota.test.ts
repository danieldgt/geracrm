import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'

/**
 * EP-03 — saúde da frota. Fixa:
 *   • /v1/canais marca `riscoBanimento` no não-oficial (ADR-021 visível);
 *   • /v1/frota/saude soma a entrega das últimas 24h e conta alertas abertos.
 */
const T = 'e03f0000-0000-4000-8000-000000000001'
const PV = 'e03f0000-1111-4000-8000-000000000001'
const PLANO = 'e03f0000-3333-4000-8000-000000000001'
const MODELO = 'e03f0000-4444-4000-8000-000000000001'
const CANAL = 'e03f0000-5555-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const chamar = (url: string) => app.inject({ method: 'GET', url, headers: { 'x-tenant-id': T } })

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-frota', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-frota', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'Loja Frota', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado)
             VALUES (${T}, ${CANAL}, 'whatsapp_nao_oficial', 'plugzapi', 'WA', 'conectado') ON CONFLICT DO NOTHING`
  app = await criarApp(); await app.ready()
})

afterAll(async () => {
  await dono`DELETE FROM alerta WHERE tenant_id = ${T}`
  await dono`DELETE FROM metrica_janela WHERE tenant_id = ${T}`
  await dono`DELETE FROM canal_conectado WHERE tenant_id = ${T}`
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${T}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${T}`
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('EP-03: saúde da frota', () => {
  it('/v1/canais marca riscoBanimento no não-oficial', async () => {
    const r = await chamar('/v1/canais')
    const c = (r.json() as { itens: { id: string; riscoBanimento: boolean }[] }).itens.find((x) => x.id === CANAL)
    expect(c?.riscoBanimento).toBe(true)
  })

  it('/v1/frota/saude soma entrega das 24h e conta alertas abertos', async () => {
    await dono`DELETE FROM metrica_janela WHERE tenant_id = ${T}`
    await dono`DELETE FROM alerta WHERE tenant_id = ${T}`
    await dono`INSERT INTO metrica_janela (tenant_id, metrica, bucket, valor)
               VALUES (${T}, 'envio_ok', date_trunc('hour', now()), 8), (${T}, 'envio_falha', date_trunc('hour', now()), 2)`
    await dono`INSERT INTO alerta (tenant_id, id, tipo, severidade, mensagem)
               VALUES (${T}, ${randomUUID()}, 'entrega_baixa', 'critico', 'teste')`

    const r = await chamar('/v1/frota/saude')
    const s = r.json() as { entrega: { ok: number; falha: number; taxa: number; amostras: number }; alertasAbertos: number }
    expect(s.entrega).toMatchObject({ ok: 8, falha: 2, amostras: 10 })
    expect(s.entrega.taxa).toBeCloseTo(0.8, 5)
    expect(s.alertasAbertos).toBe(1)
  })

  it('saúde sem envios: taxa null, sem quebrar', async () => {
    await dono`DELETE FROM metrica_janela WHERE tenant_id = ${T}`
    await dono`DELETE FROM alerta WHERE tenant_id = ${T}`
    const r = await chamar('/v1/frota/saude')
    const s = r.json() as { entrega: { taxa: number | null; amostras: number }; alertasAbertos: number }
    expect(s.entrega.amostras).toBe(0)
    expect(s.entrega.taxa).toBeNull()
    expect(s.alertasAbertos).toBe(0)
  })
})
