import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { encerrarBanco } from '../../db/index.js'
import { pluginTenant } from '../../plugins/tenant.js'
import { rotasPedido } from './rotas-pedido.js'

/**
 * Lista de pedidos no servidor (X6): busca `?q=`, período `?inicio&fim`, cursor, escopo por papel
 * e os contadores, que leem o MESMO filtro. Banco real, papel da aplicação (RLS), dois tenants.
 */
const A = 'e6a00000-0000-4000-8000-00000000000a'
const B = 'e6a00000-0000-4000-8000-00000000000b'
const PLANO = 'e6a00000-0001-4000-8000-000000000001'
const MODELO = 'e6a00000-0002-4000-8000-000000000001'
const PV_A = 'e6a00000-0003-4000-8000-00000000000a'
const PV_B = 'e6a00000-0003-4000-8000-00000000000b'
const U = {
  adm: 'e6a00000-0005-4000-8000-000000000001',
  va: 'e6a00000-0005-4000-8000-000000000002',
  vb: 'e6a00000-0005-4000-8000-000000000003',
  bad: 'e6a00000-0005-4000-8000-000000000004',
}
const C = {
  alfa: 'e6a00000-0006-4000-8000-000000000001',
  beta: 'e6a00000-0006-4000-8000-000000000002',
  alfaB: 'e6a00000-0006-4000-8000-000000000003',
}
const sub = (k: keyof typeof U) => `e6-sub-${k}`
const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance

type Corpo = {
  itens: { id: string; estado: string; totalCentavos: number; contato: string | null; numeroExterno: string | null }[]
  proximoCursor: string | null
  porEstado: Record<string, { quantidade: number; valorCentavos: number }>
  total: number; valorTotalCentavos: number; erro?: string
}
async function pedir(quem: keyof typeof U, url: string, tenant = A) {
  const r = await app.inject({ method: 'GET', url, headers: { 'x-tenant-id': tenant, 'x-teste-sub': sub(quem) } })
  return { status: r.statusCode, corpo: r.json() as Corpo }
}
/** Todas as páginas, seguindo o cursor. */
async function listaToda(quem: keyof typeof U, qs: string, tenant = A) {
  const paginas: Corpo[] = []
  let cursor: string | null = null
  do {
    const r = await pedir(quem, `/v1/pedidos?${qs}${cursor ? `&cursor=${cursor}` : ''}`, tenant)
    expect(r.status).toBe(200)
    paginas.push(r.corpo); cursor = r.corpo.proximoCursor
  } while (cursor)
  return paginas
}

async function limpar(): Promise<void> {
  for (const t of [A, B]) {
    await dono`DELETE FROM pedido WHERE tenant_id = ${t}`
    await dono`DELETE FROM carteira_atribuicao WHERE tenant_id = ${t}`
    await dono`DELETE FROM contato WHERE tenant_id = ${t}`
    await dono`DELETE FROM usuario_filial WHERE tenant_id = ${t}`
    await dono`DELETE FROM usuario WHERE tenant_id = ${t}`
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await limpar()
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-x6-ped', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-x6-ped', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[A, PV_A, 'X6 A'], [B, PV_B, 'X6 B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  for (const k of ['adm', 'va', 'vb'] as const) {
    await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email, ativo)
               VALUES (${A}, ${U[k]}, ${sub(k)}, ${'Pessoa ' + k}, ${sub(k) + '@x6.test'}, true)`
  }
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email, ativo)
             VALUES (${B}, ${U.bad}, ${sub('bad')}, 'Admin B', ${sub('bad') + '@x6.test'}, true)`
  await dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES
    (${A}, ${U.adm}, NULL, 'admin'), (${A}, ${U.va}, NULL, 'vendedor'), (${A}, ${U.vb}, NULL, 'vendedor'),
    (${B}, ${U.bad}, NULL, 'admin')`
  await dono`INSERT INTO contato (tenant_id, id, nome) VALUES
    (${A}, ${C.alfa}, 'X6 Cliente Alfa'), (${A}, ${C.beta}, 'X6 Cliente Beta'), (${B}, ${C.alfaB}, 'X6 Cliente Alfa')`
  await dono`INSERT INTO carteira_atribuicao (tenant_id, id, contato_id, usuario_id) VALUES
    (${A}, gen_random_uuid(), ${C.alfa}, ${U.va}), (${A}, gen_random_uuid(), ${C.beta}, ${U.vb})`

  // A: 35 da Alfa (um por dia, a partir de 2026-09-01), alternando efetivado (R$ 100,50) e rascunho (R$ 10);
  //    4 da Beta; 1 da Alfa com nº ERP 'NF-4411'. B: 3 da "Alfa" (mesmo nome, outro tenant).
  await dono`INSERT INTO pedido (tenant_id, id, contato_id, estado, total_centavos, criado_em)
    SELECT ${A}, gen_random_uuid(), ${C.alfa}, CASE WHEN g % 2 = 0 THEN 'efetivado' ELSE 'rascunho' END,
           CASE WHEN g % 2 = 0 THEN 10050 ELSE 1000 END, timestamptz '2026-09-01 12:00+00' + g * interval '1 day'
      FROM generate_series(0, 34) g`
  await dono`INSERT INTO pedido (tenant_id, id, contato_id, estado, total_centavos, criado_em)
    SELECT ${A}, gen_random_uuid(), ${C.beta}, 'falhou', 500, timestamptz '2026-10-05 12:00+00' + g * interval '1 hour'
      FROM generate_series(0, 3) g`
  await dono`INSERT INTO pedido (tenant_id, id, contato_id, estado, total_centavos, numero_externo, criado_em)
    VALUES (${A}, gen_random_uuid(), ${C.alfa}, 'efetivado', 7000, 'NF-4411', timestamptz '2026-10-20 12:00+00')`
  await dono`INSERT INTO pedido (tenant_id, id, contato_id, estado, total_centavos, criado_em)
    SELECT ${B}, gen_random_uuid(), ${C.alfaB}, 'efetivado', 999, timestamptz '2026-09-10 12:00+00' + g * interval '1 day'
      FROM generate_series(0, 2) g`

  app = Fastify()
  await app.register(pluginTenant)
  app.addHook('onRequest', async (req) => {
    const s = req.headers['x-teste-sub']
    if (typeof s === 'string') { req.usuarioSub = s; req.usuarioEmail = `${s}@x6.test` }
  })
  await app.register(rotasPedido)
  await app.ready()
})

afterAll(async () => {
  await limpar()
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app?.close(); await encerrarBanco(); await dono.end()
})

describe('lista de pedidos: busca e período no servidor', () => {
  it('busca pelo nome do contato percorre duas páginas por cursor, sem repetir nem perder', async () => {
    const paginas = await listaToda('adm', 'q=alfa')
    expect(paginas).toHaveLength(2)
    expect(paginas[0]!.itens).toHaveLength(30)
    const ids = paginas.flatMap((p) => p.itens.map((i) => i.id))
    expect(ids).toHaveLength(36) // 35 + a do NF-4411
    expect(new Set(ids).size).toBe(36)
    expect(paginas.flatMap((p) => p.itens).every((i) => i.contato === 'X6 Cliente Alfa')).toBe(true)
  })

  it('busca por nº do ERP e por código curto do pedido', async () => {
    const porNf = await pedir('adm', '/v1/pedidos?q=nf-44')
    expect(porNf.corpo.itens.map((i) => i.numeroExterno)).toEqual(['NF-4411'])
    const id = porNf.corpo.itens[0]!.id
    const codigo = id.replace(/-/g, '').slice(-6).toUpperCase()
    const porCodigo = await pedir('adm', `/v1/pedidos?q=${codigo}`)
    expect(porCodigo.corpo.itens.map((i) => i.id)).toContain(id)
  })

  it('coringa escrito na busca é literal: % não casa tudo', async () => {
    const r = await pedir('adm', '/v1/pedidos?q=%25')
    expect(r.corpo.itens).toHaveLength(0)
  })

  it('período filtra por dia inclusivo, com cursor e junto da busca', async () => {
    // 2026-09-01 .. 2026-09-10 = 10 pedidos da Alfa (g=0..9).
    const p = await listaToda('adm', 'inicio=2026-09-01&fim=2026-09-10&q=alfa')
    expect(p.flatMap((x) => x.itens)).toHaveLength(10)
    const um = await pedir('adm', '/v1/pedidos?inicio=2026-10-20&fim=2026-10-20')
    expect(um.corpo.itens.map((i) => i.numeroExterno)).toEqual(['NF-4411'])
  })

  it('período inválido, incompleto, invertido ou longo demais é 422 com código; busca longa também', async () => {
    expect((await pedir('adm', '/v1/pedidos?inicio=2026-09-01')).corpo.erro).toBe('periodo.incompleto')
    expect((await pedir('adm', '/v1/pedidos?inicio=2026-02-30&fim=2026-03-01')).corpo.erro).toBe('periodo.invalido')
    expect((await pedir('adm', '/v1/pedidos?inicio=2026-09-10&fim=2026-09-01')).corpo.erro).toBe('periodo.invertido')
    expect((await pedir('adm', '/v1/pedidos?inicio=2024-01-01&fim=2026-09-01')).corpo.erro).toBe('periodo.longo_demais')
    const r = await pedir('adm', `/v1/pedidos?q=${'x'.repeat(101)}`)
    expect(r.status).toBe(422); expect(r.corpo.erro).toBe('busca.invalida')
    const c = await pedir('adm', '/v1/pedidos/contadores?inicio=2026-09-10&fim=2026-09-01')
    expect(c.status).toBe(422)
  })

  it('escopo por papel: vendedor só enxerga os pedidos da própria carteira, com busca e contadores', async () => {
    expect((await listaToda('va', 'q=x6')).flatMap((p) => p.itens)).toHaveLength(36)
    const vb = await pedir('vb', '/v1/pedidos?q=alfa')
    expect(vb.corpo.itens).toHaveLength(0)
    expect((await pedir('vb', '/v1/pedidos/contadores?q=alfa')).corpo.total).toBe(0)
    expect((await pedir('vb', '/v1/pedidos/contadores')).corpo.total).toBe(4)
  })

  it('dois tenants: a mesma busca não cruza a fronteira', async () => {
    const b = await listaToda('bad', 'q=alfa', B)
    expect(b.flatMap((p) => p.itens)).toHaveLength(3)
    const cb = await pedir('bad', '/v1/pedidos/contadores?q=alfa', B)
    expect(cb.corpo).toMatchObject({ total: 3, valorTotalCentavos: 2997 })
  })
})

describe('contadores', () => {
  it('batem com a lista inteira (contagem e centavos por estado) para o mesmo filtro', async () => {
    const qs = 'q=alfa&inicio=2026-09-01&fim=2026-10-31'
    const itens = (await listaToda('adm', qs)).flatMap((p) => p.itens)
    const c = (await pedir('adm', `/v1/pedidos/contadores?${qs}`)).corpo
    const esperado: Record<string, { quantidade: number; valorCentavos: number }> = {}
    for (const i of itens) {
      const e = (esperado[i.estado] ??= { quantidade: 0, valorCentavos: 0 })
      e.quantidade++; e.valorCentavos += i.totalCentavos
    }
    expect(c.porEstado).toEqual(esperado)
    expect(c.total).toBe(itens.length)
    expect(c.valorTotalCentavos).toBe(itens.reduce((s, i) => s + i.totalCentavos, 0))
    // 18 efetivados de 100,50 (g par 0..34) + o NF-4411 de 70,00; 17 rascunhos de 10,00.
    expect(c.porEstado['efetivado']).toEqual({ quantidade: 19, valorCentavos: 18 * 10050 + 7000 })
    expect(c.porEstado['rascunho']).toEqual({ quantidade: 17, valorCentavos: 17000 })
  })

  it('o filtro de estado da lista não muda os contadores (eles particionam por estado)', async () => {
    const todos = (await pedir('adm', '/v1/pedidos/contadores?q=x6')).corpo
    expect(todos.total).toBe(40)
    expect(todos.porEstado['falhou']).toEqual({ quantidade: 4, valorCentavos: 2000 })
  })
})
