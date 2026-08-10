import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'

/** Retenção — funil de recompra (ciclo de vida) com fronteira configurável. */
const T = 'de50000a-0000-4000-8000-000000000001'
const OUTRO = 'de50000a-0000-4000-8000-000000000002'
const PV = 'de50000a-1111-4000-8000-000000000001'
const PV2 = 'de50000a-1111-4000-8000-000000000002'
const PLANO = 'de50000a-3333-4000-8000-000000000001'
const MODELO = 'de50000a-4444-4000-8000-000000000001'
const C_ATIVO = 'de50000a-6666-4000-8000-000000000001'
const C_INATIVO = 'de50000a-6666-4000-8000-000000000002'
const C_PERDIDO = 'de50000a-6666-4000-8000-000000000003'
const C_NOVO = 'de50000a-6666-4000-8000-000000000004' // sem compra

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const chamar = (t: string, m: 'GET' | 'PUT', url: string, corpo?: Record<string, unknown>) =>
  app.inject({ method: m, url, headers: { 'x-tenant-id': t }, ...(corpo ? { payload: corpo } : {}) })

// contato com métricas denormalizadas: dias desde a última venda controlado.
async function semearContato(id: string, diasAtras: number | null, total = 10000) {
  const qtd = diasAtras === null ? 0 : 1
  const ultima = diasAtras === null ? null : new Date(Date.now() - diasAtras * 86400000).toISOString()
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo, qtd_vendas, ultima_venda_em, total_vendas_centavos)
             VALUES (${T}, ${id}, ${'C' + id.slice(-1)}, 'teste', true, ${qtd}, ${ultima}, ${diasAtras === null ? 0 : total})
             ON CONFLICT (tenant_id, id) DO UPDATE SET qtd_vendas = EXCLUDED.qtd_vendas,
               ultima_venda_em = EXCLUDED.ultima_venda_em, total_vendas_centavos = EXCLUDED.total_vendas_centavos`
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-re', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-re', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'A'], [OUTRO, PV2, 'B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await semearContato(C_ATIVO, 10)     // <=30 → ativo
  await semearContato(C_INATIVO, 60)   // 30<..<=90 → inativo
  await semearContato(C_PERDIDO, 200)  // >90 → perdido
  await semearContato(C_NOVO, null)    // sem compra
  app = await criarApp(); await app.ready()
})

beforeEach(async () => { await dono`DELETE FROM retencao_config WHERE tenant_id IN (${T}, ${OUTRO})` })

afterAll(async () => {
  await dono`DELETE FROM retencao_config WHERE tenant_id IN (${T}, ${OUTRO})`
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

const conta = (buckets: { estado: string; contatos: number }[], estado: string) =>
  buckets.find((b) => b.estado === estado)?.contatos ?? 0

describe('Retenção (ciclo de vida)', () => {
  it('classifica por dias sem comprar com os defaults (30/90)', async () => {
    const r = (await chamar(T, 'GET', '/v1/retencao')).json() as {
      config: { diasAtivo: number; diasInativo: number }; buckets: { estado: string; contatos: number }[]
    }
    expect(r.config).toEqual({ diasAtivo: 30, diasInativo: 90 })
    expect(conta(r.buckets, 'ativo')).toBe(1)
    expect(conta(r.buckets, 'inativo')).toBe(1)
    expect(conta(r.buckets, 'perdido')).toBe(1)
    expect(conta(r.buckets, 'sem_compra')).toBe(1)
  })

  it('⚠️ a fronteira é configurável: apertar dias_ativo reclassifica', async () => {
    // Com dias_ativo=5, o cliente de 10 dias deixa de ser Ativo e vira Inativo.
    expect((await chamar(T, 'PUT', '/v1/retencao/config', { diasAtivo: 5, diasInativo: 90 })).statusCode).toBe(200)
    const r = (await chamar(T, 'GET', '/v1/retencao')).json() as { buckets: { estado: string; contatos: number }[] }
    expect(conta(r.buckets, 'ativo')).toBe(0)
    expect(conta(r.buckets, 'inativo')).toBe(2) // o de 10 dias + o de 60 dias
  })

  it('config inválida (inativo <= ativo) → 422', async () => {
    expect((await chamar(T, 'PUT', '/v1/retencao/config', { diasAtivo: 90, diasInativo: 30 })).statusCode).toBe(422)
    expect((await chamar(T, 'PUT', '/v1/retencao/config', { diasAtivo: 0, diasInativo: 90 })).statusCode).toBe(422)
  })

  it('⚠️ isolamento: a base de um tenant não conta para o outro (RLS)', async () => {
    const r = (await chamar(OUTRO, 'GET', '/v1/retencao')).json() as { totalContatos: number }
    expect(r.totalContatos).toBe(0)
  })
})
