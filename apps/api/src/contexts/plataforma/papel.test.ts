import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { encerrarBanco, comTenantServico } from '../../db/index.js'
import { pluginTenant, exigirTenant } from '../../plugins/tenant.js'
import { exigirPapel, atendePapel, papeisDoUsuario } from './papel.js'

/**
 * PAPEL — a regra única de `papel.ts`, com DOIS tenants no banco real:
 * o papel de um tenant nunca vale no outro, mesmo com o MESMO sub; tenant sem
 * papel atribuído fica em modo fundador; papel retirado deixa de valer já.
 *
 * Em dev (header x-tenant-id, sem Cognito) o sub é `dev-<tenant>`
 * (`subDoUsuario`) — é ele que as linhas de `usuario` usam aqui.
 */
const A = 'a0d50000-0000-4000-8000-000000000001'
const B = 'a0d50000-0000-4000-8000-000000000002'
const PV_A = 'a0d50000-1111-4000-8000-000000000001'
const PV_B = 'a0d50000-1111-4000-8000-000000000002'
const PLANO = 'a0d50000-3333-4000-8000-000000000001'
const MODELO = 'a0d50000-4444-4000-8000-000000000001'
const U_A = 'a0d50000-5555-4000-8000-000000000001'
const U_B_MESMO_SUB = 'a0d50000-5555-4000-8000-000000000002'
const U_B = 'a0d50000-5555-4000-8000-000000000003'
const U_A_ADMIN = 'a0d50000-5555-4000-8000-000000000004'
const SUB_A = `dev-${A}`
const SUB_B = `dev-${B}`

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const status = async (t: string, url: string) => (await app.inject({ method: 'GET', url, headers: { 'x-tenant-id': t } })).statusCode

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-papel', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-papel', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[A, PV_A, 'Papel A'], [B, PV_B, 'Papel B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${A}, ${U_A}, ${SUB_A}, 'Vera', 'vera@a.test') ON CONFLICT DO NOTHING`
  // ⚠️ O MESMO sub do usuário de A, como ADMIN de B: se a consulta escapasse do
  //    RLS, A herdaria o admin de B.
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${B}, ${U_B_MESMO_SUB}, ${SUB_A}, 'Vera', 'vera@b.test') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${B}, ${U_B}, ${SUB_B}, 'Beto', 'beto@b.test') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${A}, ${U_A_ADMIN}, 'sub-admin-papel-a', 'Ada', 'ada@a.test') ON CONFLICT DO NOTHING`

  app = Fastify()
  await app.register(pluginTenant)
  app.get('/so-admin', { preHandler: [exigirTenant, exigirPapel('admin')] }, async () => ({ ok: true }))
  app.get('/vendedor', { preHandler: [exigirTenant, exigirPapel('gestor', 'vendedor')] }, async () => ({ ok: true }))
  await app.ready()
})

afterAll(async () => {
  await dono`DELETE FROM usuario_filial WHERE tenant_id IN (${A}, ${B})`
  await dono`DELETE FROM usuario WHERE tenant_id IN (${A}, ${B})`
  for (const t of [A, B]) {
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

const acessoDe = (t: string, quem: { sub: string; atorStaff?: boolean }) => comTenantServico(t, (tx) => papeisDoUsuario(tx, quem))
const papel = (t: string, u: string, p: string) =>
  dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES (${t}, ${u}, NULL, ${p})
       ON CONFLICT (tenant_id, usuario_id) WHERE filial_id IS NULL DO UPDATE SET papel = EXCLUDED.papel`

describe('exigirPapel — dois tenants', () => {
  it('sem tenant → 401; tenant sem admin ativo → modo fundador para quem existe e está ativo', async () => {
    expect((await app.inject({ method: 'GET', url: '/so-admin' })).statusCode).toBe(401)
    expect(await status(A, '/so-admin')).toBe(200)
    expect(await status(B, '/so-admin')).toBe(200)
    expect(await acessoDe(A, { sub: SUB_A })).toEqual({ papeis: ['admin'], origem: 'fundador' })
  })

  it('modo fundador exige usuário existente e ativo', async () => {
    expect(await acessoDe(A, { sub: 'sub-que-nao-existe-papel' })).toEqual({ papeis: [], origem: 'nenhum' })
    await dono`UPDATE usuario SET ativo = false WHERE tenant_id = ${A} AND id = ${U_A}`
    expect(await status(A, '/so-admin')).toBe(403)
    await dono`UPDATE usuario SET ativo = true WHERE tenant_id = ${A} AND id = ${U_A}`
    expect(await status(A, '/so-admin')).toBe(200)
  })

  it('só "atendente" atribuído não encerra o modo fundador', async () => {
    await papel(A, U_A, 'atendente')
    expect(await acessoDe(A, { sub: SUB_A })).toEqual({ papeis: ['admin'], origem: 'fundador' })
    expect(await status(A, '/so-admin')).toBe(200)
  })

  it('com um admin ativo a regra fica estrita, e o admin de B (mesmo sub) não vale em A', async () => {
    await papel(A, U_A_ADMIN, 'admin')
    await papel(A, U_A, 'vendedor')
    await papel(B, U_B_MESMO_SUB, 'admin')

    const r = await app.inject({ method: 'GET', url: '/so-admin', headers: { 'x-tenant-id': A } })
    expect(r.statusCode).toBe(403)
    expect(r.json()).toMatchObject({ erro: 'acesso.papel_insuficiente', exige: ['admin'] })
    expect(await status(A, '/vendedor')).toBe(200)
    expect(await acessoDe(A, { sub: SUB_A })).toEqual({ papeis: ['vendedor'], origem: 'atribuido' })

    // Em B, quem chama (dev-B) não tem papel nenhum — e B tem admin ativo.
    expect(await status(B, '/so-admin')).toBe(403)
    expect(await status(B, '/vendedor')).toBe(403)
  })

  it('admin DESATIVADO não conta: o tenant volta ao modo fundador', async () => {
    await dono`UPDATE usuario SET ativo = false WHERE tenant_id = ${A} AND id = ${U_A_ADMIN}`
    expect(await status(A, '/so-admin')).toBe(200)
    await dono`UPDATE usuario SET ativo = true WHERE tenant_id = ${A} AND id = ${U_A_ADMIN}`
    expect(await status(A, '/so-admin')).toBe(403)
  })

  it('papel retirado ou usuário desativado deixa de valer na próxima requisição', async () => {
    await papel(B, U_B, 'gestor')
    expect(await status(B, '/vendedor')).toBe(200)
    await dono`UPDATE usuario SET ativo = false WHERE tenant_id = ${B} AND id = ${U_B}`
    expect(await status(B, '/vendedor')).toBe(403)
    await dono`UPDATE usuario SET ativo = true WHERE tenant_id = ${B} AND id = ${U_B}`
    await dono`DELETE FROM usuario_filial WHERE tenant_id = ${B} AND usuario_id = ${U_B}`
    expect(await status(B, '/vendedor')).toBe(403)
  })

  it('sessão de staff age como admin do cliente, mesmo num tenant estrito e sem linha de usuário', async () => {
    expect(await acessoDe(B, { sub: 'staff-sem-usuario', atorStaff: true })).toEqual({ papeis: ['admin'], origem: 'staff' })
  })
})

describe('atendePapel — regra pura', () => {
  it('admin satisfaz tudo; os demais só quando listados', () => {
    expect(atendePapel({ papeis: ['admin'], origem: 'atribuido' }, ['gestor'])).toBe(true)
    expect(atendePapel({ papeis: ['vendedor'], origem: 'atribuido' }, ['gestor'])).toBe(false)
    expect(atendePapel({ papeis: ['vendedor'], origem: 'atribuido' }, ['gestor', 'vendedor'])).toBe(true)
    expect(atendePapel({ papeis: [], origem: 'nenhum' }, [])).toBe(false)
  })
})
