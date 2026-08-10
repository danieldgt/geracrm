import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'

/** Mapa de Clientes — distribuição por endereço declarado (sem geocoding). */
const T = 'ba7a0000-0000-4000-8000-000000000001'
const OUTRO = 'ba7a0000-0000-4000-8000-000000000002'
const PV = 'ba7a0000-1111-4000-8000-000000000001'
const PV2 = 'ba7a0000-1111-4000-8000-000000000002'
const PLANO = 'ba7a0000-3333-4000-8000-000000000001'
const MODELO = 'ba7a0000-4444-4000-8000-000000000001'
const C_SP1 = 'ba7a0000-6666-4000-8000-000000000001'
const C_SP2 = 'ba7a0000-6666-4000-8000-000000000002'
const C_PE = 'ba7a0000-6666-4000-8000-000000000003'
const C_SEM = 'ba7a0000-6666-4000-8000-000000000004'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const chamar = (t: string, url: string) => app.inject({ method: 'GET', url, headers: { 'x-tenant-id': t } })

async function contatoCom(id: string, cidade: string | null, uf: string | null) {
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES (${T}, ${id}, ${'C-' + id.slice(-1)}, 'teste', true) ON CONFLICT DO NOTHING`
  if (cidade || uf) {
    await dono`INSERT INTO contato_endereco (tenant_id, contato_id, seq, cidade, uf, principal, fonte)
               VALUES (${T}, ${id}, 1, ${cidade}, ${uf}, true, 'teste') ON CONFLICT DO NOTHING`
  }
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-ma', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-ma', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'A'], [OUTRO, PV2, 'B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await contatoCom(C_SP1, 'São Paulo', 'SP')
  await contatoCom(C_SP2, 'Campinas', 'SP')
  await contatoCom(C_PE, 'Recife', 'PE')
  await contatoCom(C_SEM, null, null)
  app = await criarApp(); await app.ready()
})

afterAll(async () => {
  await dono`DELETE FROM contato_endereco WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM contato WHERE tenant_id IN (${T}, ${OUTRO})`
  for (const t of [T, OUTRO]) {
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('Mapa de Clientes (sem geocoding)', () => {
  it('agrupa por UF e cidade; conta "sem endereço" honestamente', async () => {
    const r = (await chamar(T, '/v1/mapa')).json() as {
      total: number; semEndereco: number
      porEstado: { uf: string; contatos: number }[]
      porCidade: { cidade: string; uf: string | null; contatos: number }[]
    }
    expect(r.total).toBe(4)
    expect(r.semEndereco).toBe(1)
    const sp = r.porEstado.find((e) => e.uf === 'SP')
    expect(sp?.contatos).toBe(2) // São Paulo + Campinas
    expect(r.porEstado.find((e) => e.uf === 'PE')?.contatos).toBe(1)
    expect(r.porEstado[0]!.uf).toBe('SP') // ordenado por contagem
    const recife = r.porCidade.find((c) => c.cidade === 'Recife')
    expect(recife).toMatchObject({ uf: 'PE', contatos: 1 })
  })

  it('⚠️ isolamento: base de um tenant não conta para outro (RLS)', async () => {
    const r = (await chamar(OUTRO, '/v1/mapa')).json() as { total: number }
    expect(r.total).toBe(0)
  })
})
