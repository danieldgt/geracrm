import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'
import { MODELOS_FUNIL } from '../crm/funil-modelos.js'

/**
 * Cadastro de clientes pelo staff — as únicas rotas que criam dado fora do
 * escopo de um tenant.
 *
 * ⚠️ O guard é lido a CADA request (`process.env.DEV_STAFF`), então dá para
 * exercitar staff e não-staff no mesmo arquivo ligando e desligando a chave.
 */
const T_STAFF = 'c17e0000-0000-4000-8000-000000000001'
const PV = 'c17e0000-1111-4000-8000-000000000001'
const PLANO = 'c17e0000-3333-4000-8000-000000000001'
const MODELO = 'c17e0000-4444-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const criados: string[] = []

const chamar = (m: 'GET' | 'POST', url: string, corpo?: Record<string, unknown>) =>
  app.inject({ method: m, url, headers: { 'x-tenant-id': T_STAFF }, ...(corpo ? { payload: corpo } : {}) })

const apagarTenant = async (id: string) => {
  await dono`DELETE FROM auditoria WHERE tenant_id = ${id}`
  await dono`DELETE FROM funil_etapa WHERE tenant_id = ${id}`
  await dono`DELETE FROM motivo_perda WHERE tenant_id = ${id}`
  await dono`DELETE FROM usuario WHERE tenant_id = ${id}`
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${id}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${id}`
  await dono`DELETE FROM tenant WHERE id = ${id}`
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-cli', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-cli', 'Atacado') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T_STAFF}, 'Drezz (staff)', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T_STAFF}, ${PV}, ${MODELO}, 'Atacado') ON CONFLICT DO NOTHING`
  })
  app = await criarApp(); await app.ready()
})

beforeEach(() => { process.env.DEV_STAFF = 'on' })

afterAll(async () => {
  delete process.env.DEV_STAFF
  for (const id of criados) await apagarTenant(id)
  await dono`DELETE FROM auditoria WHERE tenant_id = ${T_STAFF}`
  await dono`DELETE FROM usuario WHERE tenant_id = ${T_STAFF}`
  await apagarTenant(T_STAFF)
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

const criarCliente = async (corpo: Record<string, unknown>) => {
  const r = await chamar('POST', '/v1/plataforma/clientes', corpo)
  const id = (r.json() as { id?: string }).id
  if (id) criados.push(id)
  return r
}

describe('Plataforma: cadastro de clientes', () => {
  it('⚠️ quem não é staff não passa', async () => {
    delete process.env.DEV_STAFF
    expect((await chamar('GET', '/v1/plataforma/clientes')).statusCode).toBe(403)
    expect((await chamar('GET', '/v1/plataforma/opcoes')).statusCode).toBe(403)
    expect((await chamar('POST', '/v1/plataforma/clientes', { nome: 'X' })).statusCode).toBe(403)
  })

  it('as opções trazem planos, verticais e os modelos de funil', async () => {
    const r = await chamar('GET', '/v1/plataforma/opcoes')
    expect(r.statusCode).toBe(200)
    const b = r.json<{
      planos: { codigo: string }[]; verticais: { codigo: string }[]
      modelosFunil: { codigo: string; etapas: unknown[] }[]
    }>()
    expect(b.planos.map((p) => p.codigo)).toContain('plano-cli')
    expect(b.verticais.map((v) => v.codigo)).toContain('modelo-cli')
    expect(b.modelosFunil.map((m) => m.codigo).sort()).toEqual(['crm-recompra', 'erp-software'])
  })

  it('cria o cliente já com o funil do modelo ERP', async () => {
    const r = await criarCliente({
      nome: 'Drezz Fábrica', planoCodigo: 'plano-cli', verticalCodigo: 'modelo-cli', modeloFunil: 'erp-software',
    })
    expect(r.statusCode).toBe(201)
    const { id, login } = r.json<{ id: string; login: { criado: boolean } }>()
    expect(login.criado).toBe(false) // sem admin no corpo, não tenta criar login

    const etapas = await dono<{ chave: string; tipo: string }[]>`
      SELECT chave, tipo FROM funil_etapa WHERE tenant_id = ${id} ORDER BY ordem`
    expect(etapas.map((e) => e.chave)).toEqual(MODELOS_FUNIL['erp-software'].etapas.map((e) => e.chave))
    expect(etapas.find((e) => e.chave === 'assinou')!.tipo).toBe('ganho')

    const motivos = await dono<{ codigo: string }[]>`SELECT codigo FROM motivo_perda WHERE tenant_id = ${id}`
    expect(motivos.map((m) => m.codigo)).toContain('ja_tem_sistema')
  })

  it('o modelo padrão é o de recompra quando não se escolhe', async () => {
    const r = await criarCliente({ nome: 'Atacado Qualquer', planoCodigo: 'plano-cli', verticalCodigo: 'modelo-cli' })
    expect(r.statusCode).toBe(201)
    const { id } = r.json<{ id: string }>()
    const etapas = await dono<{ chave: string }[]>`SELECT chave FROM funil_etapa WHERE tenant_id = ${id} ORDER BY ordem`
    expect(etapas.map((e) => e.chave)).toEqual(MODELOS_FUNIL['crm-recompra'].etapas.map((e) => e.chave))
  })

  it('o cliente criado aparece na lista e a criação fica auditada', async () => {
    const r = await criarCliente({ nome: 'Confecção Listada', planoCodigo: 'plano-cli', verticalCodigo: 'modelo-cli' })
    const { id } = r.json<{ id: string }>()

    const lista = (await chamar('GET', '/v1/plataforma/clientes')).json<{ itens: { id: string; nome: string }[] }>()
    expect(lista.itens.find((t) => t.id === id)?.nome).toBe('Confecção Listada')

    // ⚠️ a trilha fica no tenant de QUEM criou, não no cliente novo
    const [aud] = await dono<{ acao: string; entidade_id: string }[]>`
      SELECT acao, entidade_id FROM auditoria WHERE tenant_id = ${T_STAFF} AND entidade_id = ${id}`
    expect(aud?.acao).toBe('cliente.criado')
  })

  it('recusa corpo incompleto e referência inexistente', async () => {
    expect((await chamar('POST', '/v1/plataforma/clientes', {})).statusCode).toBe(422)
    expect((await chamar('POST', '/v1/plataforma/clientes',
      { nome: 'X', verticalCodigo: 'modelo-cli' })).statusCode).toBe(422)
    const r = await chamar('POST', '/v1/plataforma/clientes',
      { nome: 'X', planoCodigo: 'nao-existe', verticalCodigo: 'modelo-cli' })
    expect(r.statusCode).toBe(422)
    expect(r.json<{ erro: string }>().erro).toBe('cliente.plano_nao_encontrado')
  })

  it('modelo de funil desconhecido é recusado antes de criar qualquer coisa', async () => {
    const antes = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM tenant`
    const r = await chamar('POST', '/v1/plataforma/clientes',
      { nome: 'X', planoCodigo: 'plano-cli', verticalCodigo: 'modelo-cli', modeloFunil: 'inventado' })
    expect(r.statusCode).toBe(422)
    const depois = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM tenant`
    expect(depois[0]!.n).toBe(antes[0]!.n)
  })

  it('⚠️ pedir login sem a API configurada falha ANTES de criar o cliente', async () => {
    const chave = process.env.AWS_ACCESS_KEY_ID
    delete process.env.AWS_ACCESS_KEY_ID
    const antes = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM tenant`

    const r = await chamar('POST', '/v1/plataforma/clientes', {
      nome: 'Com Login', planoCodigo: 'plano-cli', verticalCodigo: 'modelo-cli',
      admin: { nome: 'Fulano', email: 'fulano@exemplo.com.br' },
    })
    expect(r.statusCode).toBe(503)

    const depois = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM tenant`
    expect(depois[0]!.n).toBe(antes[0]!.n) // nenhum tenant órfão
    if (chave !== undefined) process.env.AWS_ACCESS_KEY_ID = chave
  })
})
