import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco, comTenantServico } from '../../db/index.js'
import { pluginTenant, exigirTenant } from '../../plugins/tenant.js'
import { exigirModulo, moduloAtivo } from './modulos.js'

/**
 * Configurações da empresa (D5): contato + LGPD por campo, papel, dois tenants,
 * chaves de módulo (padrão desligado) e `exigirModulo` → 404.
 *
 * Em dev (header x-tenant-id) o sub é `dev-<tenant>`. Enquanto o tenant não tem
 * admin atribuído, quem chama é "fundador" (admin); com a Ada admin, vale o papel.
 */
const A = 'd5e00000-0000-4000-8000-000000000001'
const B = 'd5e00000-0000-4000-8000-000000000002'
const PV_A = 'd5e00000-1111-4000-8000-000000000001'
const PV_B = 'd5e00000-1111-4000-8000-000000000002'
const PLANO = 'd5e00000-3333-4000-8000-000000000001'
const MODELO = 'd5e00000-4444-4000-8000-000000000001'
const U_DEV_A = 'd5e00000-5555-4000-8000-000000000001'
const U_ADA_A = 'd5e00000-5555-4000-8000-000000000002'
const CNPJ_OK = '11222333000181'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
let appModulo: FastifyInstance
const chamar = (t: string, m: 'GET' | 'PATCH' | 'PUT', url: string, corpo?: Record<string, unknown>) =>
  app.inject({ method: m, url, headers: { 'x-tenant-id': t }, ...(corpo ? { payload: corpo } : {}) })

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-d5', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-d5', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[A, PV_A, 'D5 A'], [B, PV_B, 'D5 B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${A}, ${U_DEV_A}, ${'dev-' + A}, 'Dev', 'dev@a.test') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${A}, ${U_ADA_A}, 'sub-ada-d5', 'Ada', 'ada@a.test') ON CONFLICT DO NOTHING`
  app = await criarApp(); await app.ready()

  appModulo = Fastify()
  await appModulo.register(pluginTenant)
  appModulo.get('/agenda-teste', { preHandler: [exigirTenant, exigirModulo('agenda')] }, async () => ({ ok: true }))
  await appModulo.ready()
})

afterAll(async () => {
  await dono`DELETE FROM auditoria WHERE tenant_id IN (${A}, ${B})`
  await dono`DELETE FROM tenant_modulo WHERE tenant_id IN (${A}, ${B})`
  await dono`DELETE FROM usuario_filial WHERE tenant_id IN (${A}, ${B})`
  await dono`DELETE FROM usuario WHERE tenant_id IN (${A}, ${B})`
  for (const t of [A, B]) {
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await appModulo.close(); await encerrarBanco(); await dono.end()
})

describe('Empresa: contato e LGPD', () => {
  it('GET traz os padrões (retenção 12, consentimento desligado)', async () => {
    const e = (await chamar(A, 'GET', '/v1/config/empresa')).json()
    expect(e).toMatchObject({
      nome: 'D5 A', plano: 'plano-d5', cnpj: null, endereco: null, retencaoMeses: 12, exigirConsentimentoWhatsapp: false,
    })
  })

  it('PATCH grava contato e LGPD (parcial: o que não veio fica)', async () => {
    const r = await chamar(A, 'PATCH', '/v1/config/empresa', {
      cnpj: '11.222.333/0001-81', telefone: '(11) 3333-4444', whatsapp: '11912345678', email: 'Contato@A.test',
      site: 'https://a.test', dpoNome: 'Dora', dpoEmail: 'dpo@a.test', retencaoMeses: 24,
      textoConsentimento: 'Autorizo o contato.', exigirConsentimentoWhatsapp: true,
      endereco: { cep: '01310-100', logradouro: 'Av. Paulista', numero: '1', bairro: 'Bela Vista', cidade: 'São Paulo', uf: 'sp' },
    })
    expect(r.statusCode).toBe(200)
    await chamar(A, 'PATCH', '/v1/config/empresa', { nome: 'D5 A Renomeada' })
    const e = (await chamar(A, 'GET', '/v1/config/empresa')).json()
    expect(e).toMatchObject({
      nome: 'D5 A Renomeada', cnpj: CNPJ_OK, telefone: '1133334444', whatsapp: '11912345678', email: 'contato@a.test',
      site: 'https://a.test', dpoNome: 'Dora', dpoEmail: 'dpo@a.test', retencaoMeses: 24, exigirConsentimentoWhatsapp: true,
      endereco: { cep: '01310100', uf: 'SP', cidade: 'São Paulo' },
    })
  })

  it('vazio limpa campo opcional', async () => {
    await chamar(A, 'PATCH', '/v1/config/empresa', { site: '', endereco: null })
    const e = (await chamar(A, 'GET', '/v1/config/empresa')).json()
    expect(e).toMatchObject({ site: null, endereco: null, cnpj: CNPJ_OK })
  })

  it('422 por campo: {erro:"validacao", campos}, e NADA é gravado', async () => {
    const r = await chamar(A, 'PATCH', '/v1/config/empresa', {
      nome: 'Não deve gravar', cnpj: '11222333000182', email: 'x', site: 'http://inseguro.test', retencaoMeses: 3,
      fuso: 'Brasil/Ceara', endereco: { cep: '12' },
    })
    expect(r.statusCode).toBe(422)
    const j = r.json() as { erro: string; campos: Record<string, string> }
    expect(j.erro).toBe('validacao')
    expect(Object.keys(j.campos).sort()).toEqual(['cnpj', 'email', 'endereco.cep', 'fuso', 'retencaoMeses', 'site'])
    expect(((await chamar(A, 'GET', '/v1/config/empresa')).json() as { nome: string }).nome).toBe('D5 A Renomeada')
    expect((await chamar(A, 'PATCH', '/v1/config/empresa', { nome: '  ' })).statusCode).toBe(422)
  })

  it('o CHECK do banco também segura retenção fora da faixa', async () => {
    await expect(dono`UPDATE tenant SET retencao_meses = 5 WHERE id = ${A}`).rejects.toThrow()
    await expect(dono`UPDATE tenant SET retencao_meses = 121 WHERE id = ${A}`).rejects.toThrow()
  })

  it('PATCH é só de admin: com admin atribuído, gestor leva 403 e lê normalmente', async () => {
    await dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES (${A}, ${U_ADA_A}, NULL, 'admin')`
    await dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES (${A}, ${U_DEV_A}, NULL, 'gestor')`
    const negado = await chamar(A, 'PATCH', '/v1/config/empresa', { dpoNome: 'Intruso' })
    expect(negado.statusCode).toBe(403)
    expect(((await chamar(A, 'GET', '/v1/config/eu')).json() as { admin: boolean }).admin).toBe(false)
    expect((await chamar(A, 'GET', '/v1/config/empresa')).statusCode).toBe(200)
    expect((await chamar(A, 'GET', '/v1/config/modulos')).statusCode).toBe(200)
    expect((await chamar(A, 'PUT', '/v1/config/modulos/agenda', { ativo: true })).statusCode).toBe(403)
    expect(((await chamar(A, 'GET', '/v1/config/empresa')).json() as { dpoNome: string }).dpoNome).toBe('Dora')
    await dono`UPDATE usuario_filial SET papel = 'admin' WHERE tenant_id = ${A} AND usuario_id = ${U_DEV_A}`
    expect(((await chamar(A, 'GET', '/v1/config/eu')).json() as { admin: boolean }).admin).toBe(true)
    expect((await chamar(A, 'PATCH', '/v1/config/empresa', { dpoNome: 'Dora Admin' })).statusCode).toBe(200)
  })

  it('auditoria guarda só os nomes dos campos', async () => {
    const [l] = await dono<{ dados: { campos: string[] } }[]>`
      SELECT dados FROM auditoria WHERE tenant_id = ${A} AND acao = 'empresa.alterada' ORDER BY criado_em DESC LIMIT 1`
    expect(l?.dados.campos).toEqual(['dpoNome'])
  })

  it('isolamento: editar a empresa de B não mexe na de A', async () => {
    await chamar(B, 'PATCH', '/v1/config/empresa', { cnpj: '11222333000181', dpoNome: 'Beto', retencaoMeses: 60 })
    const a = (await chamar(A, 'GET', '/v1/config/empresa')).json() as { dpoNome: string; retencaoMeses: number }
    const b = (await chamar(B, 'GET', '/v1/config/empresa')).json() as { dpoNome: string; retencaoMeses: number }
    expect(a).toMatchObject({ dpoNome: 'Dora Admin', retencaoMeses: 24 })
    expect(b).toMatchObject({ dpoNome: 'Beto', retencaoMeses: 60 })
  })
})

describe('Módulos', () => {
  it('padrão DESLIGADO quando não há linha', async () => {
    const r = (await chamar(B, 'GET', '/v1/config/modulos')).json()
    expect(r).toEqual({ modulos: { agenda: false } })
    expect(await comTenantServico(B, (tx) => moduloAtivo(tx, 'agenda'))).toBe(false)
  })

  it('admin liga e desliga, com auditoria; módulo desconhecido 404; corpo inválido 422', async () => {
    expect((await chamar(A, 'PUT', '/v1/config/modulos/agenda', { ativo: true })).json()).toEqual({ modulos: { agenda: true } })
    expect(((await chamar(A, 'GET', '/v1/config/modulos')).json() as { modulos: { agenda: boolean } }).modulos.agenda).toBe(true)
    expect((await chamar(A, 'PUT', '/v1/config/modulos/foguete', { ativo: true })).statusCode).toBe(404)
    expect((await chamar(A, 'PUT', '/v1/config/modulos/agenda', { ativo: 'sim' })).statusCode).toBe(422)
    const [l] = await dono<{ dados: { modulo: string; antes: boolean; depois: boolean } }[]>`
      SELECT dados FROM auditoria WHERE tenant_id = ${A} AND acao = 'modulo.alterado' ORDER BY criado_em DESC LIMIT 1`
    expect(l?.dados).toEqual({ modulo: 'agenda', antes: false, depois: true })
  })

  it('isolamento: ligar em A não liga em B', async () => {
    expect(((await chamar(B, 'GET', '/v1/config/modulos')).json() as { modulos: { agenda: boolean } }).modulos.agenda).toBe(false)
  })

  it('o banco só aceita módulo conhecido', async () => {
    await expect(dono`INSERT INTO tenant_modulo (tenant_id, modulo, ativo) VALUES (${B}, 'foguete', true)`).rejects.toThrow()
  })

  it('exigirModulo: 404 desligado, passa ligado, 401 sem tenant', async () => {
    const get = (t?: string) => appModulo.inject({ method: 'GET', url: '/agenda-teste', headers: t ? { 'x-tenant-id': t } : {} })
    expect((await get(B)).statusCode).toBe(404)
    expect((await get(B)).json()).toMatchObject({ erro: 'modulo.desligado' })
    expect((await get(A)).statusCode).toBe(200)
    expect((await get()).statusCode).toBe(401)
    await chamar(A, 'PUT', '/v1/config/modulos/agenda', { ativo: false })
    expect((await get(A)).statusCode).toBe(404)
  })
})
