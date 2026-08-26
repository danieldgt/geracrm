import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'

/** Fidelidade — leitura do saldo do ERP + degradação honesta sem a capacidade. */
const T = 'f1de0000-0000-4000-8000-000000000001'
const OUTRO = 'f1de0000-0000-4000-8000-000000000002'
const PV = 'f1de0000-1111-4000-8000-000000000001'
const PV2 = 'f1de0000-1111-4000-8000-000000000002'
const PLANO = 'f1de0000-3333-4000-8000-000000000001'
const MODELO = 'f1de0000-4444-4000-8000-000000000001'
const C1 = 'f1de0000-6666-4000-8000-000000000001'
const CONEXAO = 'f1de0000-7777-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const chamar = (t: string, url: string) => app.inject({ method: 'GET', url, headers: { 'x-tenant-id': t } })

async function limparConexoes() {
  await dono`DELETE FROM conexao_erp WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM fidelidade_saldo WHERE tenant_id IN (${T}, ${OUTRO})`
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-fi', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-fi', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'A'], [OUTRO, PV2, 'B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES (${T}, ${C1}, 'Cliente Fiel', 'teste', true) ON CONFLICT DO NOTHING`
  app = await criarApp(); await app.ready()
})

beforeEach(limparConexoes)

afterAll(async () => {
  await limparConexoes()
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

async function conexao(fidelidade: boolean) {
  await dono`INSERT INTO conexao_erp (tenant_id, id, conector, nome_amigavel, capacidades, estado)
             VALUES (${T}, ${CONEXAO}, 'geracloud', 'Nosso ERP',
                     ${JSON.stringify({ fidelidade })}::text::jsonb, 'ativa')`
}

describe('Fidelidade (degradação sem ERP)', () => {
  it('⚠️ sem conector → indisponível (blocos somem, com motivo)', async () => {
    const r = (await chamar(T, '/v1/fidelidade')).json() as { disponivel: boolean; motivo: string }
    expect(r).toMatchObject({ disponivel: false, motivo: 'sem_conector' })
  })

  it('⚠️ conector SEM a capacidade fidelidade → indisponível (erp_sem_fidelidade)', async () => {
    await conexao(false)
    const r = (await chamar(T, '/v1/fidelidade')).json() as { disponivel: boolean; motivo: string }
    expect(r).toMatchObject({ disponivel: false, motivo: 'erp_sem_fidelidade' })
  })

  it('conector COM fidelidade → disponível, com resumo e top saldos', async () => {
    await conexao(true)
    await dono`INSERT INTO fidelidade_saldo (tenant_id, contato_id, saldo, unidade) VALUES (${T}, ${C1}, 15000, 'centavos')`
    const r = (await chamar(T, '/v1/fidelidade')).json() as {
      disponivel: boolean; resumo: { clientesComSaldo: number; totalSaldo: number }
      topSaldos: { contato: string; saldo: number }[]
    }
    expect(r.disponivel).toBe(true)
    expect(r.resumo).toMatchObject({ clientesComSaldo: 1, totalSaldo: 15000 })
    expect(r.topSaldos[0]).toMatchObject({ contato: 'Cliente Fiel', saldo: 15000 })
  })

  it('saldo por contato (ficha) respeita a disponibilidade', async () => {
    // Sem capacidade → indisponível.
    expect(((await chamar(T, `/v1/contatos/${C1}/fidelidade`)).json() as { disponivel: boolean }).disponivel).toBe(false)
    await conexao(true)
    await dono`INSERT INTO fidelidade_saldo (tenant_id, contato_id, saldo, unidade) VALUES (${T}, ${C1}, 800, 'pontos')`
    const r = (await chamar(T, `/v1/contatos/${C1}/fidelidade`)).json() as { disponivel: boolean; saldo: number; unidade: string }
    expect(r).toMatchObject({ disponivel: true, saldo: 800, unidade: 'pontos' })
  })

  it('⚠️ isolamento: conector/saldo de um tenant não vaza para o outro (RLS)', async () => {
    await conexao(true)
    const r = (await chamar(OUTRO, '/v1/fidelidade')).json() as { disponivel: boolean; motivo: string }
    expect(r).toMatchObject({ disponivel: false, motivo: 'sem_conector' })
  })
})
