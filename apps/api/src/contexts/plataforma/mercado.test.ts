import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'

/** Visão de Mercado — fotografia da base (cobertura + origem + RFV). */
const T = 'de5d0000-0000-4000-8000-000000000001'
const OUTRO = 'de5d0000-0000-4000-8000-000000000002'
const PV = 'de5d0000-1111-4000-8000-000000000001'
const PV2 = 'de5d0000-1111-4000-8000-000000000002'
const PLANO = 'de5d0000-3333-4000-8000-000000000001'
const MODELO = 'de5d0000-4444-4000-8000-000000000001'
const C_ZAP = 'de5d0000-6666-4000-8000-000000000001'   // com whatsapp + comprou
const C_SEM = 'de5d0000-6666-4000-8000-000000000002'   // sem telefone, opt-out

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const chamar = (t: string, url: string) => app.inject({ method: 'GET', url, headers: { 'x-tenant-id': t } })

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-mk', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-mk', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'A'], [OUTRO, PV2, 'B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo, qtd_vendas, recebe_campanhas)
             VALUES (${T}, ${C_ZAP}, 'Com Zap', 'erp', true, 3, true) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo, qtd_vendas, recebe_campanhas)
             VALUES (${T}, ${C_SEM}, 'Sem nada', 'whatsapp', true, 0, false) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
             VALUES (${T}, ${C_ZAP}, 1, '+5511999990000', '5511999990000', true, true, 'whatsapp') ON CONFLICT DO NOTHING`
  app = await criarApp(); await app.ready()
})

afterAll(async () => {
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

describe('Visão de Mercado', () => {
  it('mede tamanho, cobertura e origem da base', async () => {
    const r = (await chamar(T, '/v1/mercado')).json() as {
      total: number
      cobertura: { comWhatsapp: number; comTelefone: number; optOut: number; jaCompraram: number }
      porOrigem: { origem: string; contatos: number }[]
    }
    expect(r.total).toBe(2)
    expect(r.cobertura.comWhatsapp).toBe(1)
    expect(r.cobertura.comTelefone).toBe(1)
    expect(r.cobertura.optOut).toBe(1)     // o C_SEM
    expect(r.cobertura.jaCompraram).toBe(1) // o C_ZAP
    const origens = Object.fromEntries(r.porOrigem.map((o) => [o.origem, o.contatos]))
    expect(origens['erp']).toBe(1)
    expect(origens['whatsapp']).toBe(1)
  })

  it('⚠️ isolamento: a base de um tenant não conta para outro (RLS)', async () => {
    const r = (await chamar(OUTRO, '/v1/mercado')).json() as { total: number }
    expect(r.total).toBe(0)
  })
})
