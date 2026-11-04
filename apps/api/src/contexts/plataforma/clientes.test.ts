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
    const antes = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM tenant WHERE plano_id = ${PLANO}`
    const r = await chamar('POST', '/v1/plataforma/clientes',
      { nome: 'X', planoCodigo: 'plano-cli', verticalCodigo: 'modelo-cli', modeloFunil: 'inventado' })
    expect(r.statusCode).toBe(422)
    const depois = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM tenant WHERE plano_id = ${PLANO}`
    expect(depois[0]!.n).toBe(antes[0]!.n)
  })

  it('⚠️ pedir login sem a API configurada falha ANTES de criar o cliente', async () => {
    const chave = process.env.AWS_ACCESS_KEY_ID
    delete process.env.AWS_ACCESS_KEY_ID
    const antes = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM tenant WHERE plano_id = ${PLANO}`

    const r = await chamar('POST', '/v1/plataforma/clientes', {
      nome: 'Com Login', planoCodigo: 'plano-cli', verticalCodigo: 'modelo-cli',
      admin: { nome: 'Fulano', email: 'fulano@exemplo.com.br' },
    })
    expect(r.statusCode).toBe(503)

    const depois = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM tenant WHERE plano_id = ${PLANO}`
    expect(depois[0]!.n).toBe(antes[0]!.n) // nenhum tenant órfão
    if (chave !== undefined) process.env.AWS_ACCESS_KEY_ID = chave
  })
})

describe('Plataforma: semear o admin do cliente (revisão D3, M6)', () => {
  it('só staff; atribui admin a um usuário ATIVO do cliente e audita nos dois tenants', async () => {
    const r = await criarCliente({ nome: 'Cliente Sem Admin', planoCodigo: 'plano-cli', verticalCodigo: 'modelo-cli' })
    const { id } = r.json<{ id: string }>()
    const ana = 'c17e0000-5555-4000-8000-000000000001'
    const inativo = 'c17e0000-5555-4000-8000-000000000002'
    await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email, ativo) VALUES
      (${id}, ${ana}, 'c17e-sub-ana', 'Ana Dona', 'ana@cliente.test', true),
      (${id}, ${inativo}, 'c17e-sub-ina', 'Ex Funcionário', 'ex@cliente.test', false)`

    delete process.env.DEV_STAFF
    expect((await chamar('POST', `/v1/plataforma/clientes/${id}/admin`, { usuarioId: ana })).statusCode).toBe(403)
    process.env.DEV_STAFF = 'on'

    const inexistente = await chamar('POST', `/v1/plataforma/clientes/${id}/admin`, { usuarioId: 'c17e0000-5555-4000-8000-0000000000ff' })
    expect(inexistente.statusCode).toBe(404)
    expect(inexistente.json<{ erro: string }>().erro).toBe('usuario.nao_encontrado')
    expect((await chamar('POST', `/v1/plataforma/clientes/${id}/admin`, { usuarioId: inativo })).statusCode).toBe(404)
    const outroCliente = await chamar('POST', '/v1/plataforma/clientes/c17e0000-5555-4000-8000-0000000000ee/admin', { usuarioId: ana })
    expect(outroCliente.json<{ erro: string }>().erro).toBe('cliente.nao_encontrado')

    const ok = await chamar('POST', `/v1/plataforma/clientes/${id}/admin`, { usuarioId: ana })
    expect(ok.statusCode).toBe(200)
    const vinc = await dono<{ papel: string; filial_id: string | null }[]>`
      SELECT papel, filial_id FROM usuario_filial WHERE tenant_id = ${id} AND usuario_id = ${ana}`
    expect(vinc).toEqual([{ papel: 'admin', filial_id: null }])
    const [noCliente] = await dono<{ ator_staff: boolean; ator_id: string | null }[]>`
      SELECT ator_staff, ator_id FROM auditoria WHERE tenant_id = ${id} AND acao = 'usuario.admin_semeado'`
    expect(noCliente).toEqual({ ator_staff: true, ator_id: null })
    const [noStaff] = await dono`SELECT 1 FROM auditoria WHERE tenant_id = ${T_STAFF} AND acao = 'cliente.admin_semeado' AND entidade_id = ${id}`
    expect(noStaff).toBeDefined()
    // Repetir é idempotente (um vínculo de tenant inteiro só).
    expect((await chamar('POST', `/v1/plataforma/clientes/${id}/admin`, { usuarioId: ana })).statusCode).toBe(200)
    const [n] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM usuario_filial WHERE tenant_id = ${id} AND usuario_id = ${ana}`
    expect(n!.n).toBe(1)
  })
})

describe('Plataforma: usuários de um cliente (escolha do admin)', () => {
  it('só staff; busca no servidor; cursor sem repetir nem pular; não vaza usuário de outro cliente', async () => {
    const a = (await criarCliente({ nome: 'Cliente Usuarios A', planoCodigo: 'plano-cli', verticalCodigo: 'modelo-cli' })).json<{ id: string }>().id
    const b = (await criarCliente({ nome: 'Cliente Usuarios B', planoCodigo: 'plano-cli', verticalCodigo: 'modelo-cli' })).json<{ id: string }>().id
    const uuid = (n: number) => `c17e0000-7777-4000-8000-${String(n).padStart(12, '0')}`
    for (let i = 1; i <= 35; i++) {
      await dono`INSERT INTO usuario (tenant_id, id, nome, email) VALUES
        (${a}, ${uuid(i)}, ${'Pessoa ' + String(i).padStart(2, '0')}, ${`p${i}@a.test`})`
    }
    await dono`INSERT INTO usuario (tenant_id, id, nome, email) VALUES (${b}, ${uuid(100)}, 'Intruso B', 'intruso@b.test')`
    await dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES (${a}, ${uuid(1)}, NULL, 'admin')`

    delete process.env.DEV_STAFF
    expect((await chamar('GET', `/v1/plataforma/clientes/${a}/usuarios`)).statusCode).toBe(403)
    process.env.DEV_STAFF = 'on'

    const vistos: string[] = []
    let cursor: string | null = null
    let paginas = 0
    do {
      const r = await chamar('GET', `/v1/plataforma/clientes/${a}/usuarios${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`)
      expect(r.statusCode).toBe(200)
      const j: { itens: { id: string; papeis: string[] }[]; proximoCursor: string | null } = r.json()
      vistos.push(...j.itens.map((u) => u.id))
      if (paginas === 0) expect(j.itens[0]).toMatchObject({ nome: 'Pessoa 01', ativo: true, papeis: ['admin'] })
      cursor = j.proximoCursor
      paginas++
    } while (cursor)
    expect(paginas).toBe(2)
    expect(vistos).toHaveLength(35)
    expect(new Set(vistos).size).toBe(35)
    expect(vistos).not.toContain(uuid(100))

    const busca = (await chamar('GET', `/v1/plataforma/clientes/${a}/usuarios?busca=p7@`)).json<{ itens: { id: string }[] }>()
    expect(busca.itens.map((u) => u.id)).toEqual([uuid(7)])
    const doB = (await chamar('GET', `/v1/plataforma/clientes/${b}/usuarios`)).json<{ itens: { nome: string }[] }>()
    expect(doB.itens.map((u) => u.nome)).toEqual(['Intruso B'])

    expect((await chamar('GET', `/v1/plataforma/clientes/${a}/usuarios?cursor=lixo`)).statusCode).toBe(422)
    const inexistente = await chamar('GET', '/v1/plataforma/clientes/c17e0000-5555-4000-8000-0000000000ee/usuarios')
    expect(inexistente.statusCode).toBe(404)
  })
})
