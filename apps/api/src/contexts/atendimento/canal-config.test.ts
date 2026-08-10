import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'

/** Config do Canal — horário/ausência/assinatura + pausa de disparo. */
const T = 'ca0f0000-0000-4000-8000-000000000001'
const OUTRO = 'ca0f0000-0000-4000-8000-000000000002'
const PV = 'ca0f0000-1111-4000-8000-000000000001'
const PV2 = 'ca0f0000-1111-4000-8000-000000000002'
const PLANO = 'ca0f0000-3333-4000-8000-000000000001'
const MODELO = 'ca0f0000-4444-4000-8000-000000000001'
const CANAL = 'ca0f0000-7777-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const chamar = (t: string, m: 'GET' | 'PUT' | 'POST', url: string, corpo?: Record<string, unknown>) =>
  app.inject({ method: m, url, headers: { 'x-tenant-id': t }, ...(corpo ? { payload: corpo } : {}) })

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-cc', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-cc', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'A'], [OUTRO, PV2, 'B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado)
             VALUES (${T}, ${CANAL}, 'whatsapp_oficial', 'Loja Centro', 'conectado') ON CONFLICT DO NOTHING`
  app = await criarApp(); await app.ready()
})

beforeEach(async () => { await dono`DELETE FROM canal_configuracao WHERE tenant_id IN (${T}, ${OUTRO})` })

afterAll(async () => {
  await dono`DELETE FROM canal_configuracao WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM canal_conectado WHERE tenant_id IN (${T}, ${OUTRO})`
  for (const t of [T, OUTRO]) {
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('Config do Canal', () => {
  it('sem config = defaults; salvar e reler', async () => {
    const vazio = (await chamar(T, 'GET', `/v1/canais/${CANAL}/config`)).json() as { assinatura: string | null; disparoPausado: boolean }
    expect(vazio).toMatchObject({ assinatura: null, disparoPausado: false })

    const put = await chamar(T, 'PUT', `/v1/canais/${CANAL}/config`, {
      horarioAtendimento: { seg: { de: '08:00', ate: '18:00' } },
      mensagemAusencia: 'Voltamos às 8h.', assinatura: 'Equipe Loja Centro',
    })
    expect(put.statusCode).toBe(200)
    const lido = (await chamar(T, 'GET', `/v1/canais/${CANAL}/config`)).json() as {
      assinatura: string; mensagemAusencia: string; horarioAtendimento: Record<string, unknown>
    }
    expect(lido.assinatura).toBe('Equipe Loja Centro')
    expect(lido.mensagemAusencia).toBe('Voltamos às 8h.')
    expect(lido.horarioAtendimento).toMatchObject({ seg: { de: '08:00', ate: '18:00' } })
  })

  it('horário inválido (não-objeto) → 422; canal inexistente → 404', async () => {
    expect((await chamar(T, 'PUT', `/v1/canais/${CANAL}/config`, { horarioAtendimento: 'seg-sex' })).statusCode).toBe(422)
    expect((await chamar(T, 'GET', `/v1/canais/${randomUUID()}/config`)).statusCode).toBe(404)
  })

  it('⚠️ pausar exige motivo; retomar zera (invariante do banco)', async () => {
    expect((await chamar(T, 'POST', `/v1/canais/${CANAL}/config/pausar`, {})).statusCode).toBe(422) // sem motivo
    expect((await chamar(T, 'POST', `/v1/canais/${CANAL}/config/pausar`, { motivo: 'Qualidade caiu' })).statusCode).toBe(200)

    const pausado = (await chamar(T, 'GET', `/v1/canais/${CANAL}/config`)).json() as { disparoPausado: boolean; pausadoMotivo: string }
    expect(pausado).toMatchObject({ disparoPausado: true, pausadoMotivo: 'Qualidade caiu' })

    expect((await chamar(T, 'POST', `/v1/canais/${CANAL}/config/retomar`)).statusCode).toBe(200)
    const ativo = (await chamar(T, 'GET', `/v1/canais/${CANAL}/config`)).json() as { disparoPausado: boolean; pausadoMotivo: string | null }
    expect(ativo).toMatchObject({ disparoPausado: false, pausadoMotivo: null })
  })

  it('⚠️ isolamento: canal de um tenant não é configurável por outro (RLS)', async () => {
    expect((await chamar(OUTRO, 'GET', `/v1/canais/${CANAL}/config`)).statusCode).toBe(404)
    expect((await chamar(OUTRO, 'PUT', `/v1/canais/${CANAL}/config`, { assinatura: 'x' })).statusCode).toBe(404)
  })
})
