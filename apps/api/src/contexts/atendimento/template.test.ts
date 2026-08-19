import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'

/** Templates (HSM): criar rascunho PENDING, unicidade nome+idioma, nova versão,
 *  apagar só se não submetido, isolamento por tenant. */
const T = 'b1000000-0000-4000-8000-000000000001'
const OUTRO = 'b1000000-0000-4000-8000-000000000002'
const PV = 'b1000000-1111-4000-8000-000000000001'
const PV2 = 'b1000000-1111-4000-8000-000000000002'
const PLANO = 'b1000000-3333-4000-8000-000000000001'
const MODELO = 'b1000000-4444-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const chamar = (t: string, m: 'GET' | 'POST' | 'DELETE', url: string, corpo?: Record<string, unknown>) =>
  app.inject({ method: m, url, headers: { 'x-tenant-id': t }, ...(corpo ? { payload: corpo } : {}) })
const CORPO = { header: { texto: 'Novidades' }, body: { texto: 'Olá {{1}}, chegou reposição.' }, footer: { texto: 'Loja X' } }

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-tpl', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-tpl', 'Varejo') ON CONFLICT DO NOTHING`
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
  await dono`DELETE FROM template_versao WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM template WHERE tenant_id IN (${T}, ${OUTRO})`
})

afterAll(async () => {
  await dono`DELETE FROM template_versao WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM template WHERE tenant_id IN (${T}, ${OUTRO})`
  for (const t of [T, OUTRO]) {
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

const criar = (t: string, nome: string, extra?: Record<string, unknown>) =>
  chamar(t, 'POST', '/v1/templates', { nome, categoria: 'MARKETING', corpo: CORPO, ...extra })

describe('Templates (HSM)', () => {
  it('cria rascunho PENDING v1 e aparece no catálogo', async () => {
    const r = await criar(T, 'reposicao_mensal')
    expect(r.statusCode).toBe(201)
    const lista = (await chamar(T, 'GET', '/v1/templates')).json() as {
      itens: { id: string; nome: string; versao: number; statusMeta: string; categoria: string; submetido: boolean }[]
    }
    expect(lista.itens.length).toBe(1)
    expect(lista.itens[0]).toMatchObject({ nome: 'reposicao_mensal', versao: 1, statusMeta: 'PENDING', categoria: 'MARKETING', submetido: false })
  })

  it('nome+idioma duplicado → 409; nome/categoria/corpo inválidos → 422', async () => {
    expect((await criar(T, 'promo')).statusCode).toBe(201)
    expect((await criar(T, 'promo')).statusCode).toBe(409)
    expect((await chamar(T, 'POST', '/v1/templates', { nome: 'Promo Maiúscula', categoria: 'MARKETING', corpo: CORPO })).statusCode).toBe(422)
    expect((await chamar(T, 'POST', '/v1/templates', { nome: 'x', categoria: 'INEXISTENTE', corpo: CORPO })).statusCode).toBe(422)
    expect((await chamar(T, 'POST', '/v1/templates', { nome: 'sem_corpo', categoria: 'UTILITY', corpo: { body: { texto: '' } } })).statusCode).toBe(422)
  })

  it('editar cria nova versão; o catálogo mostra a última', async () => {
    const id = (await criar(T, 'aviso')).json() as { id: string }
    const nova = await chamar(T, 'POST', `/v1/templates/${id.id}/versao`, { corpo: { body: { texto: 'Texto revisado {{1}}' } } })
    expect(nova.statusCode).toBe(201)
    expect((nova.json() as { versao: number }).versao).toBe(2)
    const det = (await chamar(T, 'GET', `/v1/templates/${id.id}`)).json() as { versoes: { versao: number }[] }
    expect(det.versoes.map((v) => v.versao)).toEqual([2, 1])
    const lista = (await chamar(T, 'GET', '/v1/templates')).json() as { itens: { versao: number }[] }
    expect(lista.itens[0]!.versao).toBe(2)
  })

  it('apaga rascunho não submetido; submetido (id_externo) → 409', async () => {
    const id = ((await criar(T, 'descartavel')).json() as { id: string }).id
    // Simula submissão à Meta.
    await dono`UPDATE template_versao SET id_externo = 'meta-123' WHERE tenant_id = ${T} AND template_id = ${id}`
    expect((await chamar(T, 'DELETE', `/v1/templates/${id}`)).statusCode).toBe(409)
    // Sem id_externo → apaga.
    const id2 = ((await criar(T, 'apagavel')).json() as { id: string }).id
    expect((await chamar(T, 'DELETE', `/v1/templates/${id2}`)).statusCode).toBe(200)
  })

  it('⚠️ isolamento: um tenant não vê nem apaga template do outro', async () => {
    const id = ((await criar(T, 'privado')).json() as { id: string }).id
    await criar(OUTRO, 'do_outro')
    const listaOutro = (await chamar(OUTRO, 'GET', '/v1/templates')).json() as { itens: { nome: string }[] }
    expect(listaOutro.itens.map((i) => i.nome)).toEqual(['do_outro'])
    expect((await chamar(OUTRO, 'DELETE', `/v1/templates/${id}`)).statusCode).toBe(404)
  })
})
