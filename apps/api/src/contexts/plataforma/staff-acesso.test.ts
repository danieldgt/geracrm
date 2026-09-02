import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'

/**
 * PLT-05 — sessão de acesso do staff ao tenant de um cliente.
 *
 * ⚠️ Aqui o token de acesso é usado DE VERDADE (header Authorization), não o
 * `x-tenant-id` de dev: é o caminho que a produção percorre, e é o único jeito
 * de provar que o tenant sai do token e que a sessão expira e revoga.
 */
const T_STAFF = 'a5e50000-0000-4000-8000-000000000001'
const T_CLI = 'a5e50000-0000-4000-8000-000000000002'
const PV1 = 'a5e50000-1111-4000-8000-000000000001'
const PV2 = 'a5e50000-1111-4000-8000-000000000002'
const PLANO = 'a5e50000-3333-4000-8000-000000000001'
const MODELO = 'a5e50000-4444-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance

/** Chamada como staff (header de dev + DEV_STAFF). */
const comoStaff = (m: 'GET' | 'POST' | 'DELETE', url: string, corpo?: Record<string, unknown>) =>
  app.inject({ method: m, url, headers: { 'x-tenant-id': T_STAFF }, ...(corpo ? { payload: corpo } : {}) })

/** Chamada COM o token de acesso — sem header de tenant nenhum. */
const comToken = (token: string, m: 'GET' | 'POST' | 'DELETE', url: string, corpo?: Record<string, unknown>) =>
  app.inject({ method: m, url, headers: { authorization: `Bearer ${token}` }, ...(corpo ? { payload: corpo } : {}) })

const abrir = async (motivo = 'suporte ao cliente') => {
  const r = await comoStaff('POST', '/v1/staff/acessos', { tenantId: T_CLI, motivo })
  return r.json<{ token: string; cliente: { nome: string } }>()
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-staff', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-staff', 'Atacado') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T_STAFF, PV1, 'Drezz (staff)'], [T_CLI, PV2, 'Confecção Cliente']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Atacado') ON CONFLICT DO NOTHING`
    })
  }
  app = await criarApp(); await app.ready()
})

beforeEach(async () => {
  process.env.DEV_STAFF = 'on'
  await dono`DELETE FROM staff_sessao WHERE tenant_id IN (${T_STAFF}, ${T_CLI})`
  await dono`DELETE FROM auditoria WHERE tenant_id IN (${T_STAFF}, ${T_CLI})`
})

afterAll(async () => {
  delete process.env.DEV_STAFF
  for (const t of [T_STAFF, T_CLI]) {
    await dono`DELETE FROM staff_sessao WHERE tenant_id = ${t}`
    await dono`DELETE FROM auditoria WHERE tenant_id = ${t}`
    // ⚠️ Ordem inversa das FKs: tarefa aponta para contato E para usuario.
    await dono`DELETE FROM tarefa WHERE tenant_id = ${t}`
    await dono`DELETE FROM contato WHERE tenant_id = ${t}`
    await dono`DELETE FROM usuario WHERE tenant_id = ${t}`
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('PLT-05: abrir a sessão', () => {
  it('⚠️ quem não é staff não abre sessão nenhuma', async () => {
    delete process.env.DEV_STAFF
    const r = await comoStaff('POST', '/v1/staff/acessos', { tenantId: T_CLI, motivo: 'x' })
    expect(r.statusCode).toBe(403)
    expect(r.json<{ erro: string }>().erro).toBe('autorizacao.sem_permissao') // e não 'erro.interno'
  })

  it('⚠️ motivo é obrigatório — acesso a dado de cliente sem justificativa, não', async () => {
    const r = await comoStaff('POST', '/v1/staff/acessos', { tenantId: T_CLI })
    expect(r.statusCode).toBe(422)
    expect(r.json<{ erro: string }>().erro).toBe('acesso.motivo_obrigatorio')
  })

  it('cliente inexistente devolve 404', async () => {
    const r = await comoStaff('POST', '/v1/staff/acessos', { tenantId: randomUUID(), motivo: 'x' })
    expect(r.statusCode).toBe(404)
  })

  it('a emissão fica auditada NO TENANT DO CLIENTE, marcada como staff', async () => {
    await abrir('investigar cobrança duplicada')
    const [aud] = await dono<{ acao: string; ator_staff: boolean; dados: { motivo: string } }[]>`
      SELECT acao, ator_staff, dados FROM auditoria WHERE tenant_id = ${T_CLI}`
    expect(aud?.acao).toBe('staff.acesso_aberto')
    expect(aud?.ator_staff).toBe(true) // a coluna de 0004 finalmente escrita
    expect(aud?.dados.motivo).toBe('investigar cobrança duplicada')

    const noStaff = await dono`SELECT 1 FROM auditoria WHERE tenant_id = ${T_STAFF}`
    expect(noStaff).toHaveLength(0) // a trilha é do cliente, que é quem precisa vê-la
  })
})

describe('PLT-05: usar a sessão', () => {
  it('o token leva ao tenant do CLIENTE, sem header de tenant', async () => {
    const { token } = await abrir()
    const r = await comToken(token, 'GET', '/v1/eu')
    expect(r.statusCode).toBe(200)
    expect(r.json<{ tenant: { nome: string } }>().tenant.nome).toBe('Confecção Cliente')
  })

  it('⚠️ a sessão NÃO dá acesso às rotas de plataforma (menor privilégio)', async () => {
    const { token } = await abrir()
    // ⚠️ DEV_STAFF fora daqui: o bypass de dev faz QUALQUER chamada passar por
    //    `exigirStaff` e mascararia justamente o que este teste prova. Em
    //    produção ele não existe; o teste tem de refletir produção.
    delete process.env.DEV_STAFF
    expect((await comToken(token, 'GET', '/v1/plataforma/clientes')).statusCode).toBe(403)
    expect((await comToken(token, 'POST', '/v1/staff/acessos',
      { tenantId: T_CLI, motivo: 'encadear' })).statusCode).toBe(403)
  })

  it('⚠️ escrever dentro do cliente funciona — o caso que o único global quebrava', async () => {
    // O staff já existe como usuário no tenant dele, com o MESMO sub que a
    // sessão vai carregar. Antes da 0081+0082, o `ON CONFLICT (cognito_sub)`
    // caía nesta linha, o RLS recusava e a rota respondia 500.
    await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email)
               VALUES (${T_STAFF}, ${randomUUID()}, 'staff-sem-sub', 'Staff', 'staff@drezz.com.br')
               ON CONFLICT DO NOTHING`

    const { token } = await abrir()
    const r = await comToken(token, 'POST', '/v1/tarefas',
      { titulo: 'Ligar para o cliente', venceEm: '2026-12-01T12:00:00Z' })
    expect(r.statusCode).toBe(201)

    // Duas linhas, mesmo sub, tenants diferentes — o que o schema já queria.
    const linhas = await dono<{ tenant_id: string }[]>`
      SELECT tenant_id FROM usuario WHERE cognito_sub = 'staff-sem-sub' ORDER BY tenant_id`
    expect(linhas).toHaveLength(2)
  })

  it('encerrar mata o acesso na hora', async () => {
    const { token } = await abrir()
    expect((await comToken(token, 'DELETE', '/v1/staff/acessos/atual')).statusCode).toBe(200)
    expect((await comToken(token, 'GET', '/v1/eu')).statusCode).toBe(401)
  })

  it('sessão expirada não resolve', async () => {
    const { token } = await abrir()
    await dono`UPDATE staff_sessao SET expira_em = now() - interval '1 minute' WHERE tenant_id = ${T_CLI}`
    expect((await comToken(token, 'GET', '/v1/eu')).statusCode).toBe(401)
  })

  it('token inventado não resolve, e não cai no header de dev', async () => {
    expect((await comToken('staff_naoexiste', 'GET', '/v1/eu')).statusCode).toBe(401)
  })
})

describe('PLT-05: isolamento', () => {
  it('⚠️ a sessão de um cliente não enxerga dado de outro', async () => {
    const idNoStaff = randomUUID()
    await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo)
               VALUES (${T_STAFF}, ${idNoStaff}, 'Segredo do Drezz', 'teste', true)`
    const { token } = await abrir()
    const r = await comToken(token, 'GET', '/v1/contatos')
    expect(r.statusCode).toBe(200)
    const nomes = r.json<{ itens: { nome: string }[] }>().itens.map((c) => c.nome)
    expect(nomes).not.toContain('Segredo do Drezz')
  })
})
