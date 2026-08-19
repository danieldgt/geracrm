import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'

/** CRM Avançado: baldes por nº de pedidos com PRIORIDADE (descartado > representante
 *  > frequência), particionando a base; card com segmento RFV; isolamento. */
const T = 'ca000000-0000-4000-8000-000000000001'
const OUTRO = 'ca000000-0000-4000-8000-000000000002'
const PV = 'ca000000-1111-4000-8000-000000000001'
const PV2 = 'ca000000-1111-4000-8000-000000000002'
const PLANO = 'ca000000-3333-4000-8000-000000000001'
const MODELO = 'ca000000-4444-4000-8000-000000000001'
const C_LEAD = 'ca000000-6666-4000-8000-000000000001'
const C_P1 = 'ca000000-6666-4000-8000-000000000002'
const C_P3 = 'ca000000-6666-4000-8000-000000000003'
const C_REP = 'ca000000-6666-4000-8000-000000000004'
const C_DESC = 'ca000000-6666-4000-8000-000000000005'
const C_OFF = 'ca000000-6666-4000-8000-000000000006'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const chamar = (t: string, m: 'GET' | 'POST', url: string) =>
  app.inject({ method: m, url, headers: { 'x-tenant-id': t } })

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-cav', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-cav', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'A'], [OUTRO, PV2, 'B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  app = await criarApp(); await app.ready()
})

beforeEach(async () => {
  await dono`DELETE FROM contato WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo, qtd_vendas) VALUES (${T}, ${C_LEAD}, 'Lead Zero', 'teste', true, 0)`
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo, qtd_vendas, total_vendas_centavos, ultima_venda_em) VALUES (${T}, ${C_P1}, 'Um Pedido', 'teste', true, 1, 10000, now() - interval '5 days')`
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo, qtd_vendas, total_vendas_centavos, ultima_venda_em) VALUES (${T}, ${C_P3}, 'Fiel Tres', 'teste', true, 3, 50000, now() - interval '2 days')`
  // Representante COM vendas: prioridade manda para 'representantes', não 'p2'.
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo, qtd_vendas, representante) VALUES (${T}, ${C_REP}, 'Rep Dois', 'teste', true, 2, true)`
  // Descartado COM muitas vendas: prioridade manda para 'descartados', não 'p3'.
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo, qtd_vendas, qualificado, qualificado_em) VALUES (${T}, ${C_DESC}, 'Fora', 'teste', true, 5, false, now())`
  // Inativo: nunca aparece.
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo, qtd_vendas) VALUES (${T}, ${C_OFF}, 'Sumido', 'teste', false, 4)`
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

type Colunas = { colunas: { chave: string; nome: string; total: number }[] }
const total = (c: Colunas, chave: string) => c.colunas.find((x) => x.chave === chave)!.total

describe('CRM Avançado', () => {
  it('particiona a base por balde com prioridade (descartado/representante acima da frequência)', async () => {
    const c = (await chamar(T, 'GET', '/v1/crm-avancado/colunas')).json() as Colunas
    expect(c.colunas.map((x) => x.chave)).toEqual(['leads', 'p1', 'p2', 'p3', 'representantes', 'descartados'])
    expect(total(c, 'leads')).toBe(1)
    expect(total(c, 'p1')).toBe(1)
    expect(total(c, 'p2')).toBe(0) // o de 2 pedidos é representante → sai de p2
    expect(total(c, 'p3')).toBe(1) // o de 5 pedidos é descartado → NÃO conta aqui
    expect(total(c, 'representantes')).toBe(1)
    expect(total(c, 'descartados')).toBe(1)
    // Soma dos baldes = base ativa (6 - 1 inativo = 5).
    expect(c.colunas.reduce((s, x) => s + x.total, 0)).toBe(5)
  })

  it('coluna 3+ traz o card com segmento RFV; coluna Leads não tem segmento', async () => {
    const p3 = (await chamar(T, 'GET', '/v1/crm-avancado/coluna/p3')).json() as {
      itens: { contatoId: string; nome: string; qtdVendas: number; totalCentavos: number; segmento: { codigo: string; rotulo: string } | null; conteudo?: unknown }[]
    }
    expect(p3.itens.length).toBe(1)
    expect(p3.itens[0]).toMatchObject({ nome: 'Fiel Tres', qtdVendas: 3, totalCentavos: 50000 })
    expect(p3.itens[0]!.segmento).not.toBeNull()
    expect('conteudo' in p3.itens[0]!).toBe(false)

    const leads = (await chamar(T, 'GET', '/v1/crm-avancado/coluna/leads')).json() as { itens: { nome: string; segmento: unknown }[] }
    expect(leads.itens[0]).toMatchObject({ nome: 'Lead Zero', segmento: null })
  })

  it('coluna inválida → 422', async () => {
    expect((await chamar(T, 'GET', '/v1/crm-avancado/coluna/xpto')).statusCode).toBe(422)
  })

  it('⚠️ isolamento: um tenant não vê a base do outro', async () => {
    await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo, qtd_vendas) VALUES (${OUTRO}, ${randomUUID()}, 'Do Outro', 'teste', true, 3)`
    const c = (await chamar(OUTRO, 'GET', '/v1/crm-avancado/colunas')).json() as Colunas
    expect(total(c, 'p3')).toBe(1)
    expect(total(c, 'leads')).toBe(0)
    const p3 = (await chamar(OUTRO, 'GET', '/v1/crm-avancado/coluna/p3')).json() as { itens: { nome: string }[] }
    expect(p3.itens.map((i) => i.nome)).toEqual(['Do Outro'])
  })
})
