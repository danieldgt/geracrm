import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { encerrarBanco } from '../../../db/index.js'
import { pluginTenant } from '../../../plugins/tenant.js'
import { rotasCompliance } from './rotas-compliance.js'

/**
 * GET/PUT /v1/canais/:id/agente/compliance — dois tenants no banco real.
 * Só admin grava; a gravação é auditada com {antes, depois}; o número de outro
 * tenant não existe; a base nunca aparece como editável.
 *
 * Em dev (header x-tenant-id) o sub é `dev-<tenant>`.
 */
const A = 'c0a10000-0000-4000-8000-000000000001'
const B = 'c0a10000-0000-4000-8000-000000000002'
const PV_A = 'c0a10000-1111-4000-8000-000000000001'
const PV_B = 'c0a10000-1111-4000-8000-000000000002'
const PLANO = 'c0a10000-3333-4000-8000-000000000001'
const MODELO = 'c0a10000-4444-4000-8000-000000000001'
const CANAL_A = 'c0a10000-5555-4000-8000-000000000001'
const CANAL_B = 'c0a10000-5555-4000-8000-000000000002'
const U_A = 'c0a10000-6666-4000-8000-000000000001'
const U_A_ADMIN = 'c0a10000-6666-4000-8000-000000000002'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const url = (canal: string) => `/v1/canais/${canal}/agente/compliance`
const get = (t: string, canal: string) => app.inject({ method: 'GET', url: url(canal), headers: { 'x-tenant-id': t } })
const put = (t: string, canal: string, payload: unknown) =>
  app.inject({ method: 'PUT', url: url(canal), headers: { 'x-tenant-id': t }, payload: payload as object })

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-rotas-compliance', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-rotas-compliance', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, canal] of [[A, PV_A, CANAL_A], [B, PV_B, CANAL_B]] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${`Compliance ${t.slice(-1)}`}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
    await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES (${t}, ${canal}, 'whatsapp_nao_oficial', 'Loja', 'conectado') ON CONFLICT DO NOTHING`
  }
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${A}, ${U_A}, ${`dev-${A}`}, 'Vera', 'vera@compliance.test') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${A}, ${U_A_ADMIN}, 'sub-admin-compliance', 'Ada', 'ada@compliance.test') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${B}, ${crypto.randomUUID()}, ${`dev-${B}`}, 'Beto', 'beto@compliance.test') ON CONFLICT DO NOTHING`

  app = Fastify()
  await app.register(pluginTenant)
  await app.register(rotasCompliance)
  await app.ready()
})

afterAll(async () => {
  for (const t of [A, B]) {
    for (const tab of ['auditoria', 'agente_config', 'usuario_filial', 'usuario', 'canal_conectado']) await dono.unsafe(`DELETE FROM ${tab} WHERE tenant_id = '${t}'`)
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('Compliance do número — rotas', () => {
  it('dado número sem configuração, quando lê, então vem vazio com a base descrita (não editável)', async () => {
    const r = await get(A, CANAL_A)
    expect(r.statusCode).toBe(200)
    const corpo = r.json()
    expect(corpo).toMatchObject({ frasesProibidas: [], gatilhosHandoff: [], limites: { maxItens: 50, maxCaracteres: 80 }, podeEditar: true })
    expect(corpo.base.map((b: { id: string }) => b.id)).toContain('garantia_sem_fonte')
  })

  it('dado admin (modo fundador), quando grava, então deduplica, persiste e audita antes/depois', async () => {
    const r = await put(A, CANAL_A, { frasesProibidas: ['Consignação', 'consignacao', ' pronta  entrega '], gatilhosHandoff: ['advogado'] })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ ok: true, frasesProibidas: ['Consignação', 'pronta entrega'], gatilhosHandoff: ['advogado'] })
    expect((await get(A, CANAL_A)).json()).toMatchObject({ frasesProibidas: ['Consignação', 'pronta entrega'], gatilhosHandoff: ['advogado'] })

    const [cfg] = await dono<{ modo: string }[]>`SELECT modo FROM agente_config WHERE tenant_id = ${A} AND canal_id = ${CANAL_A}`
    expect(cfg!.modo).toBe('desligado') // gravar compliance não liga o agente

    const [aud] = await dono<{ acao: string; entidade_id: string; ator_id: string | null; dados: { antes: unknown; depois: unknown } }[]>`
      SELECT acao, entidade_id, ator_id, dados FROM auditoria WHERE tenant_id = ${A} AND acao = 'agente.compliance_alterado' ORDER BY criado_em DESC LIMIT 1`
    expect(aud).toMatchObject({
      entidade_id: CANAL_A, ator_id: U_A,
      dados: { antes: { frasesProibidas: [], gatilhosHandoff: [] }, depois: { frasesProibidas: ['Consignação', 'pronta entrega'], gatilhosHandoff: ['advogado'] } },
    })
  })

  it('dado corpo fora dos limites ou com campo estranho, então 422 nomeando o campo', async () => {
    const muitos = await put(A, CANAL_A, { frasesProibidas: Array.from({ length: 51 }, (_, i) => `frase ${i}`), gatilhosHandoff: [] })
    expect(muitos.statusCode).toBe(422)
    expect(muitos.json()).toMatchObject({ erro: 'compliance.campo_invalido', campos: ['frasesProibidas'] })
    expect((await put(A, CANAL_A, { frasesProibidas: ['x'.repeat(81)] })).statusCode).toBe(422)
    expect((await put(A, CANAL_A, { frasesProibidas: [], desligarBase: true })).statusCode).toBe(422)
  })

  it('dado número de outro tenant, então 404 na leitura e na gravação — e nada muda lá', async () => {
    expect((await get(A, CANAL_B)).statusCode).toBe(404)
    expect((await put(A, CANAL_B, { frasesProibidas: ['invasão'] })).statusCode).toBe(404)
    expect((await get(B, CANAL_B)).json()).toMatchObject({ frasesProibidas: [] })
    expect((await get(B, CANAL_A)).statusCode).toBe(404)
  })

  it('dado tenant com admin atribuído e quem chama sem papel, então lê com podeEditar=false e não grava (403)', async () => {
    await dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES (${A}, ${U_A_ADMIN}, NULL, 'admin')`
    await dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES (${A}, ${U_A}, NULL, 'vendedor')`
    expect((await get(A, CANAL_A)).json()).toMatchObject({ podeEditar: false })
    const r = await put(A, CANAL_A, { frasesProibidas: [] })
    expect(r.statusCode).toBe(403)
    expect(r.json()).toMatchObject({ erro: 'acesso.papel_insuficiente' })
    expect((await get(A, CANAL_A)).json()).toMatchObject({ frasesProibidas: ['Consignação', 'pronta entrega'] })
  })

  it('sem tenant → 401', async () => {
    expect((await app.inject({ method: 'GET', url: url(CANAL_A) })).statusCode).toBe(401)
  })
})
