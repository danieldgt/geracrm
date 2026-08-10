import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'

/** Carteirização — posse do cliente com histórico auditável (tabela 0010). */
const T = 'ca570000-0000-4000-8000-000000000001'
const OUTRO = 'ca570000-0000-4000-8000-000000000002'
const PV = 'ca570000-1111-4000-8000-000000000001'
const PV2 = 'ca570000-1111-4000-8000-000000000002'
const PLANO = 'ca570000-3333-4000-8000-000000000001'
const MODELO = 'ca570000-4444-4000-8000-000000000001'
const VEND_A = 'ca570000-5555-4000-8000-000000000001'
const VEND_B = 'ca570000-5555-4000-8000-000000000002'
const VEND_OUTRO = 'ca570000-5555-4000-8000-00000000000f' // vendedor do tenant OUTRO
const VEND_INEXISTENTE = 'ca570000-5555-4000-8000-0000000000ff' // não existe em nenhum tenant
const C1 = 'ca570000-6666-4000-8000-000000000001'
const C2 = 'ca570000-6666-4000-8000-000000000002'
const C_OUTRO = 'ca570000-6666-4000-8000-00000000000f'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const chamar = (t: string, m: 'GET' | 'POST' | 'DELETE', url: string, corpo?: Record<string, unknown>) =>
  app.inject({ method: m, url, headers: { 'x-tenant-id': t }, ...(corpo ? { payload: corpo } : {}) })

async function semearContato(t: string, id: string, nome: string) {
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo)
             VALUES (${t}, ${id}, ${nome}, 'teste', true) ON CONFLICT DO NOTHING`
}
async function semearVendedor(t: string, id: string, nome: string) {
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email)
             VALUES (${t}, ${id}, ${'sub-' + id}, ${nome}, ${id + '@ex.com'}) ON CONFLICT DO NOTHING`
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-ca', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-ca', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'A'], [OUTRO, PV2, 'B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await semearVendedor(T, VEND_A, 'Ana')
  await semearVendedor(T, VEND_B, 'Bruno')
  await semearVendedor(OUTRO, VEND_OUTRO, 'Carla')
  await semearContato(T, C1, 'Cliente Um')
  await semearContato(T, C2, 'Cliente Dois')
  await semearContato(OUTRO, C_OUTRO, 'Cliente Alheio')
  app = await criarApp(); await app.ready()
})

beforeEach(async () => {
  await dono`DELETE FROM carteira_atribuicao WHERE tenant_id IN (${T}, ${OUTRO})`
})

afterAll(async () => {
  await dono`DELETE FROM carteira_atribuicao WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM contato WHERE tenant_id IN (${T}, ${OUTRO})`
  // O dev-user criado por garantirUsuarioId também é do tenant.
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

describe('Carteirização', () => {
  it('atribui um dono; registra no histórico; conta no resumo', async () => {
    expect((await chamar(T, 'POST', `/v1/contatos/${C1}/carteira`, { usuarioId: VEND_A })).statusCode).toBe(200)

    const resumo = (await chamar(T, 'GET', '/v1/carteiras')).json() as {
      itens: { usuarioId: string; usuario: string; clientes: number }[]; orfaos: number
    }
    const ana = resumo.itens.find((i) => i.usuarioId === VEND_A)
    expect(ana?.clientes).toBe(1)

    const hist = (await chamar(T, 'GET', `/v1/contatos/${C1}/carteira/historico`)).json() as {
      itens: { usuarioId: string | null; atual: boolean }[]
    }
    expect(hist.itens.length).toBe(1)
    expect(hist.itens[0]).toMatchObject({ usuarioId: VEND_A, atual: true })
  })

  it('⚠️ transferir A→B fecha o período de A e abre B, sem dois donos', async () => {
    await chamar(T, 'POST', `/v1/contatos/${C1}/carteira`, { usuarioId: VEND_A })
    expect((await chamar(T, 'POST', `/v1/contatos/${C1}/carteira`, { usuarioId: VEND_B, motivo: 'férias' })).statusCode).toBe(200)

    const hist = (await chamar(T, 'GET', `/v1/contatos/${C1}/carteira/historico`)).json() as {
      itens: { usuarioId: string | null; atual: boolean; motivo: string | null }[]
    }
    expect(hist.itens.length).toBe(2)
    // Ordenado por `de` desc: o atual (Bruno) primeiro.
    expect(hist.itens[0]).toMatchObject({ usuarioId: VEND_B, atual: true, motivo: 'férias' })
    expect(hist.itens[1]).toMatchObject({ usuarioId: VEND_A, atual: false })
    // Só um dono vigente.
    expect(hist.itens.filter((i) => i.atual).length).toBe(1)
  })

  it('transferir para quem já é dono não cria linha (semMudanca)', async () => {
    await chamar(T, 'POST', `/v1/contatos/${C1}/carteira`, { usuarioId: VEND_A })
    const r = await chamar(T, 'POST', `/v1/contatos/${C1}/carteira`, { usuarioId: VEND_A })
    expect(r.statusCode).toBe(200)
    expect((r.json() as { semMudanca: boolean }).semMudanca).toBe(true)
    const hist = (await chamar(T, 'GET', `/v1/contatos/${C1}/carteira/historico`)).json() as { itens: unknown[] }
    expect(hist.itens.length).toBe(1)
  })

  it('soltar o cliente o torna órfão e o lista em orfaos=1', async () => {
    await chamar(T, 'POST', `/v1/contatos/${C1}/carteira`, { usuarioId: VEND_A })
    expect((await chamar(T, 'DELETE', `/v1/contatos/${C1}/carteira`)).statusCode).toBe(200)

    const resumo = (await chamar(T, 'GET', '/v1/carteiras')).json() as {
      itens: { usuarioId: string }[]; orfaos: number
    }
    expect(resumo.itens.find((i) => i.usuarioId === VEND_A)).toBeUndefined()
    expect(resumo.orfaos).toBeGreaterThanOrEqual(1)

    const orfaos = (await chamar(T, 'GET', '/v1/carteiras/contatos?orfaos=1')).json() as { itens: { id: string }[] }
    expect(orfaos.itens.some((c) => c.id === C1)).toBe(true)
  })

  it('lista os contatos de uma carteira', async () => {
    await chamar(T, 'POST', `/v1/contatos/${C1}/carteira`, { usuarioId: VEND_A })
    await chamar(T, 'POST', `/v1/contatos/${C2}/carteira`, { usuarioId: VEND_A })
    const r = (await chamar(T, 'GET', `/v1/carteiras/contatos?usuarioId=${VEND_A}`)).json() as {
      itens: { id: string; nome: string }[]
    }
    expect(r.itens.map((c) => c.id).sort()).toEqual([C1, C2].sort())
  })

  it('dono inexistente neste tenant → 422 tipificado', async () => {
    const r = await chamar(T, 'POST', `/v1/contatos/${C1}/carteira`, { usuarioId: VEND_INEXISTENTE })
    expect(r.statusCode).toBe(422)
    expect((r.json() as { erro: string }).erro).toBe('carteira.usuario_invalido')
  })

  it('⚠️ isolamento: carteira de um tenant não aparece para outro (RLS)', async () => {
    await chamar(OUTRO, 'POST', `/v1/contatos/${C_OUTRO}/carteira`, { usuarioId: VEND_OUTRO })
    const resumo = (await chamar(T, 'GET', '/v1/carteiras')).json() as { itens: unknown[] }
    // Nenhuma atribuição do tenant OUTRO vaza para T.
    expect(resumo.itens.length).toBe(0)
  })
})
