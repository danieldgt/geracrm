import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'

/** Configurações Gerais — empresa (view/edit) + equipe com papéis. */
const T = 'c0f60000-0000-4000-8000-000000000001'
const OUTRO = 'c0f60000-0000-4000-8000-000000000002'
const PV = 'c0f60000-1111-4000-8000-000000000001'
const PV2 = 'c0f60000-1111-4000-8000-000000000002'
const PLANO = 'c0f60000-3333-4000-8000-000000000001'
const MODELO = 'c0f60000-4444-4000-8000-000000000001'
const VEND = 'c0f60000-5555-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const chamar = (t: string, m: 'GET' | 'PATCH', url: string, corpo?: Record<string, unknown>) =>
  app.inject({ method: m, url, headers: { 'x-tenant-id': t }, ...(corpo ? { payload: corpo } : {}) })

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-cf', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-cf', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'Loja Original'], [OUTRO, PV2, 'Alheia']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${T}, ${VEND}, ${'sub-' + VEND}, 'Ana', 'ana@ex.com') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES (${T}, ${VEND}, NULL, 'gestor') ON CONFLICT DO NOTHING`
  app = await criarApp(); await app.ready()
})

afterAll(async () => {
  await dono`DELETE FROM usuario_filial WHERE tenant_id IN (${T}, ${OUTRO})`
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

describe('Configurações Gerais', () => {
  it('lê e edita a empresa; nome vazio → 422', async () => {
    const e = (await chamar(T, 'GET', '/v1/config/empresa')).json() as { nome: string; fuso: string; plano: string }
    expect(e).toMatchObject({ nome: 'Loja Original', plano: 'plano-cf' })

    expect((await chamar(T, 'PATCH', '/v1/config/empresa', { nome: 'Loja Renomeada', fuso: 'America/Recife' })).statusCode).toBe(200)
    const depois = (await chamar(T, 'GET', '/v1/config/empresa')).json() as { nome: string; fuso: string }
    expect(depois).toMatchObject({ nome: 'Loja Renomeada', fuso: 'America/Recife' })

    expect((await chamar(T, 'PATCH', '/v1/config/empresa', { nome: '  ' })).statusCode).toBe(422)
  })

  it('lista a equipe com papéis por filial', async () => {
    const r = (await chamar(T, 'GET', '/v1/config/equipe')).json() as {
      itens: { nome: string; papeis: { papel: string; filial: string }[] }[]
    }
    const ana = r.itens.find((u) => u.nome === 'Ana')
    expect(ana).toBeDefined()
    expect(ana!.papeis).toEqual([{ papel: 'gestor', filial: 'Todas as filiais' }])
  })

  it('⚠️ isolamento: um tenant não edita nem enxerga a empresa do outro (RLS)', async () => {
    // OUTRO edita a SUA empresa; não afeta T.
    await chamar(OUTRO, 'PATCH', '/v1/config/empresa', { nome: 'Mudou a Alheia' })
    const minha = (await chamar(T, 'GET', '/v1/config/empresa')).json() as { nome: string }
    expect(minha.nome).toBe('Loja Renomeada') // intacta
    const equipeOutro = (await chamar(OUTRO, 'GET', '/v1/config/equipe')).json() as { itens: unknown[] }
    expect(equipeOutro.itens.length).toBe(0) // Ana é do T
  })
})
