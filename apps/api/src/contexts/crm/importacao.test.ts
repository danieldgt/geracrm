import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'

/**
 * EP-02 — importação de contatos por CSV, ponta a ponta. Fixa: cria contatos,
 * deduplica por telefone, conta rejeições, e isola por tenant.
 */
const T = 'c5f00000-0000-4000-8000-000000000001'
const PV = 'c5f00000-1111-4000-8000-000000000001'
const PLANO = 'c5f00000-3333-4000-8000-000000000001'
const MODELO = 'c5f00000-4444-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const importar = (csv: string) =>
  app.inject({ method: 'POST', url: '/v1/contatos/importar', headers: { 'x-tenant-id': T }, payload: { csv } })

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-imp', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-imp', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'Loja Imp', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  app = await criarApp(); await app.ready()
})

beforeEach(async () => {
  await dono`DELETE FROM contato_documento WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato_telefone WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato WHERE tenant_id = ${T}`
})

afterAll(async () => {
  await dono`DELETE FROM contato_documento WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato_telefone WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato WHERE tenant_id = ${T}`
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${T}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${T}`
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('EP-02: importar contatos por CSV', () => {
  it('cria contatos e grava telefone + documento', async () => {
    const r = await importar('nome,telefone,cnpj\nZé,81998617049,11222333000181\nAna,8133334444,')
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ criados: 2, atualizados: 0, rejeitados: 0 })
    const [c] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM contato WHERE tenant_id = ${T}`
    expect(c!.n).toBe(2)
    const [d] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM contato_documento WHERE tenant_id = ${T} AND tipo = 'cnpj'`
    expect(d!.n).toBe(1)
  })

  it('⚠️ deduplica por telefone: reimportar o mesmo número não cria de novo', async () => {
    await importar('nome,telefone\nZé,81998617049')
    const r = await importar('nome,telefone\nZé Silva,81998617049') // mesmo número
    expect(r.json()).toMatchObject({ criados: 0, atualizados: 1 })
    const [c] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM contato WHERE tenant_id = ${T}`
    expect(c!.n).toBe(1)
  })

  it('conta rejeições sem abortar a importação inteira', async () => {
    const r = await importar('nome,telefone\nBom,81998617049\n,88887777\nRuim,123')
    const j = r.json() as { criados: number; rejeitados: number; rejeicoes: { motivo: string }[] }
    expect(j.criados).toBe(1)
    expect(j.rejeitados).toBe(2)
    expect(j.rejeicoes.map((x) => x.motivo).sort()).toEqual(['nome_vazio', 'telefone_invalido'])
  })

  it('CSV vazio → 422', async () => {
    expect((await importar('')).statusCode).toBe(422)
  })
})
