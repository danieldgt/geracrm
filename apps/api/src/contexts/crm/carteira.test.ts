import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
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

  it('teto da equipe: itens com truncado na fronteira (200 = não corta; 201 = corta)', async () => {
    type Resumo = { itens: unknown[]; truncado: boolean; orfaos: number }
    const ler = async (t: string) => (await chamar(t, 'GET', '/v1/carteiras')).json() as Resumo
    // beforeEach zera as atribuições: a base é 0 carteiras.
    const base = (await ler(T)).itens.length
    try {
      await vendedoresComCarteira(1, 200 - base)
      const no = await ler(T)
      expect(no.itens).toHaveLength(200)
      expect(no.truncado).toBe(false)

      await vendedoresComCarteira(201 - base, 201 - base)
      const com = await ler(T)
      expect(com.itens).toHaveLength(200)
      expect(com.truncado).toBe(true)

      expect((await ler(OUTRO)).truncado).toBe(false)
    } finally {
      await dono`DELETE FROM carteira_atribuicao WHERE tenant_id = ${T} AND usuario_id IN
                 (SELECT id FROM usuario WHERE tenant_id = ${T} AND nome LIKE 'Extra %')`
      await dono`DELETE FROM contato WHERE tenant_id = ${T} AND nome LIKE 'Extra %'`
      await dono`DELETE FROM usuario WHERE tenant_id = ${T} AND nome LIKE 'Extra %'`
    }
  }, 120_000)
})

/**
 * Vendedores extras de T, cada um com UM cliente na carteira vigente. Grava direto a posse (sem o
 * `transferir_carteira`): o teste só precisa do estado; a regra de transferência já tem os seus casos acima.
 */
async function vendedoresComCarteira(de: number, ate: number) {
  for (let k = de; k <= ate; k++) {
    const usuario = randomUUID(), contato = randomUUID()
    await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email)
               VALUES (${T}, ${usuario}, ${'sub-' + usuario}, ${'Extra ' + k}, ${'extra' + k + '-' + usuario.slice(0, 8) + '@ex.com'})`
    await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES (${T}, ${contato}, ${'Extra ' + k}, 'teste', true)`
    await dono`INSERT INTO carteira_atribuicao (tenant_id, id, contato_id, usuario_id, origem)
               VALUES (${T}, ${randomUUID()}, ${contato}, ${usuario}, 'manual')`
  }
}
