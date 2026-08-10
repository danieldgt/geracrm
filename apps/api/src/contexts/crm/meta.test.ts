import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'

/** Metas de venda — alvo mensal com realizado DERIVADO das vendas. */
const T = 'dea70000-0000-4000-8000-000000000001'
const OUTRO = 'dea70000-0000-4000-8000-000000000002'
const PV = 'dea70000-1111-4000-8000-000000000001'
const PV2 = 'dea70000-1111-4000-8000-000000000002'
const PLANO = 'dea70000-3333-4000-8000-000000000001'
const MODELO = 'dea70000-4444-4000-8000-000000000001'
const VEND = 'dea70000-5555-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const chamar = (t: string, m: 'GET' | 'POST' | 'DELETE', url: string, corpo?: Record<string, unknown>) =>
  app.inject({ method: m, url, headers: { 'x-tenant-id': t }, ...(corpo ? { payload: corpo } : {}) })

// Período fixo do teste: um mês bem no passado, para não colidir com dados reais
// nem depender do relógio (as partições de venda cobrem -12..+12 meses; uso mês corrente).
const HOJE = new Date()
const ANO = HOJE.getUTCFullYear()
const MES = HOJE.getUTCMonth() + 1

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-me', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-me', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'A'], [OUTRO, PV2, 'B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email)
             VALUES (${T}, ${VEND}, ${'sub-' + VEND}, 'Ana', 'ana@ex.com') ON CONFLICT DO NOTHING`
  // Duas vendas da Ana no mês corrente (uma cancelada, que NÃO entra no realizado).
  const meio = `${ANO}-${String(MES).padStart(2, '0')}-15`
  await dono`INSERT INTO venda (tenant_id, id, contato_id, ocorrida_em, valor_centavos, usuario_id)
             VALUES (${T}, ${randomUUID()}, NULL, ${meio}, 30000, ${VEND})`
  await dono`INSERT INTO venda (tenant_id, id, contato_id, ocorrida_em, valor_centavos, usuario_id)
             VALUES (${T}, ${randomUUID()}, NULL, ${meio}, 20000, ${VEND})`
  await dono`INSERT INTO venda (tenant_id, id, contato_id, ocorrida_em, valor_centavos, usuario_id, cancelada_em)
             VALUES (${T}, ${randomUUID()}, NULL, ${meio}, 99999, ${VEND}, now())`
  app = await criarApp(); await app.ready()
})

beforeEach(async () => { await dono`DELETE FROM meta WHERE tenant_id IN (${T}, ${OUTRO})` })

afterAll(async () => {
  await dono`DELETE FROM meta WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM venda WHERE tenant_id IN (${T}, ${OUTRO})`
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

describe('Metas de venda', () => {
  it('define meta da equipe; período/alvo obrigatórios', async () => {
    expect((await chamar(T, 'POST', '/v1/metas', { ano: ANO, mes: MES, alvoCentavos: 100000 })).statusCode).toBe(201)
    expect((await chamar(T, 'POST', '/v1/metas', { ano: ANO, alvoCentavos: 100000 })).statusCode).toBe(422) // sem mês
    expect((await chamar(T, 'POST', '/v1/metas', { ano: ANO, mes: MES, alvoCentavos: 0 })).statusCode).toBe(422) // alvo <= 0
  })

  it('⚠️ realizado é derivado das vendas (canceladas fora); calcula pct', async () => {
    // Meta da equipe = 100.000; Ana vendeu 30.000 + 20.000 (a de 99.999 foi cancelada).
    await chamar(T, 'POST', '/v1/metas', { ano: ANO, mes: MES, alvoCentavos: 100000 })
    await chamar(T, 'POST', '/v1/metas', { usuarioId: VEND, ano: ANO, mes: MES, alvoCentavos: 40000 })
    const r = (await chamar(T, 'GET', `/v1/metas?ano=${ANO}&mes=${MES}`)).json() as {
      itens: { usuarioId: string | null; realizado: number; alvo: number; pct: number }[]
    }
    const equipe = r.itens.find((i) => i.usuarioId === null)
    const ana = r.itens.find((i) => i.usuarioId === VEND)
    expect(equipe).toMatchObject({ realizado: 50000, alvo: 100000, pct: 50 })
    expect(ana).toMatchObject({ realizado: 50000, alvo: 40000, pct: 125 })
  })

  it('upsert: definir de novo o mesmo período/vendedor atualiza o alvo, não duplica', async () => {
    await chamar(T, 'POST', '/v1/metas', { usuarioId: VEND, ano: ANO, mes: MES, alvoCentavos: 40000 })
    await chamar(T, 'POST', '/v1/metas', { usuarioId: VEND, ano: ANO, mes: MES, alvoCentavos: 55000 })
    const r = (await chamar(T, 'GET', `/v1/metas?ano=${ANO}&mes=${MES}`)).json() as { itens: { usuarioId: string | null; alvo: number }[] }
    const anas = r.itens.filter((i) => i.usuarioId === VEND)
    expect(anas.length).toBe(1)
    expect(anas[0]!.alvo).toBe(55000)
  })

  it('excluir uma meta', async () => {
    await chamar(T, 'POST', '/v1/metas', { ano: ANO, mes: MES, alvoCentavos: 100000 })
    const [m] = await dono<{ id: string }[]>`SELECT id FROM meta WHERE tenant_id=${T} LIMIT 1`
    expect((await chamar(T, 'DELETE', `/v1/metas/${m!.id}`)).statusCode).toBe(200)
    expect((await chamar(T, 'DELETE', `/v1/metas/${m!.id}`)).statusCode).toBe(404)
  })

  it('⚠️ isolamento: meta de um tenant não aparece para outro (RLS)', async () => {
    await chamar(OUTRO, 'POST', '/v1/metas', { ano: ANO, mes: MES, alvoCentavos: 100000 })
    const r = (await chamar(T, 'GET', `/v1/metas?ano=${ANO}&mes=${MES}`)).json() as { itens: unknown[] }
    expect(r.itens.length).toBe(0)
  })
})
