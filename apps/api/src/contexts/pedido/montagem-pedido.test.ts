import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'

/** Montagem de pedido: vários rascunhos por cliente + catálogo filtrado/paginado. */
const T = 'de550000-0000-4000-8000-000000000001'
const OUTRO = 'de550000-0000-4000-8000-000000000002'
const PV = 'de550000-1111-4000-8000-000000000001'
const PV2 = 'de550000-1111-4000-8000-000000000002'
const PLANO = 'de550000-3333-4000-8000-000000000001'
const MODELO = 'de550000-4444-4000-8000-000000000001'
const C1 = 'de550000-6666-4000-8000-000000000001'
const CANAL = 'de550000-7777-4000-8000-000000000001'
const CONV = 'de550000-8888-4000-8000-000000000001'
const PROD_A = 'de550000-aaaa-4000-8000-000000000001'
const PROD_B = 'de550000-aaaa-4000-8000-000000000002'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const chamar = (t: string, m: 'GET' | 'POST' | 'PATCH', url: string, corpo?: Record<string, unknown>) =>
  app.inject({ method: m, url, headers: { 'x-tenant-id': t }, ...(corpo ? { payload: corpo } : {}) })

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-mp', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-mp', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'A'], [OUTRO, PV2, 'B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES (${T}, ${C1}, 'Cliente MP', 'teste', true) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES (${T}, ${CANAL}, 'whatsapp_oficial', 'Zap MP', 'conectado') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id) VALUES (${T}, ${CONV}, ${CANAL}, ${C1}) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO produto (tenant_id, id, referencia, descricao, categoria, ativo) VALUES (${T}, ${PROD_A}, 'REF-A', 'Camisa Polo', 'Camisas', true) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO produto (tenant_id, id, referencia, descricao, categoria, ativo) VALUES (${T}, ${PROD_B}, 'REF-B', 'Calça Jeans', 'Calças', true) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO sku (tenant_id, id, produto_id, atributos, ativo) VALUES (${T}, ${randomUUID()}, ${PROD_A}, ${JSON.stringify({ cor: 'Azul', tamanho: 'M' })}::text::jsonb, true)`
  await dono`INSERT INTO sku (tenant_id, id, produto_id, atributos, ativo) VALUES (${T}, ${randomUUID()}, ${PROD_B}, ${JSON.stringify({ cor: 'Preto', tamanho: '42' })}::text::jsonb, true)`
  app = await criarApp(); await app.ready()
})

beforeEach(async () => { await dono`DELETE FROM pedido WHERE tenant_id IN (${T}, ${OUTRO})` })

afterAll(async () => {
  await dono`DELETE FROM pedido WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM sku WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM produto WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM conversa WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM canal_conectado WHERE tenant_id IN (${T}, ${OUTRO})`
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

describe('Vários rascunhos por cliente', () => {
  it('novo:true cria rascunhos DISTINTOS; a lista mostra todos', async () => {
    const a = (await chamar(T, 'POST', '/v1/pedidos', { contatoId: C1, nome: 'Reposição', novo: true }).then((r) => r.json())).id
    const b = (await chamar(T, 'POST', '/v1/pedidos', { contatoId: C1, nome: 'Natal', novo: true }).then((r) => r.json())).id
    expect(a).not.toBe(b)
    const lista = (await chamar(T, 'GET', `/v1/contatos/${C1}/pedidos`)).json() as { itens: { id: string; nome: string }[] }
    expect(lista.itens.length).toBe(2)
    expect(lista.itens.map((i) => i.nome).sort()).toEqual(['Natal', 'Reposição'])
  })

  it('PATCH renomeia o rascunho', async () => {
    const id = (await chamar(T, 'POST', '/v1/pedidos', { contatoId: C1, novo: true }).then((r) => r.json())).id
    expect((await chamar(T, 'PATCH', `/v1/pedidos/${id}`, { nome: 'Especial' })).statusCode).toBe(200)
    const lista = (await chamar(T, 'GET', `/v1/contatos/${C1}/pedidos`)).json() as { itens: { nome: string }[] }
    expect(lista.itens[0]!.nome).toBe('Especial')
  })

  it('⚠️ pedido criado só com a conversa herda o CONTATO dela (não fica "sem cliente")', async () => {
    // Nasceu no chat: o front manda só conversaId. O contato precisa vir da conversa,
    // senão a lista /pedidos mostra "sem cliente" mesmo depois de confirmado.
    const id = (await chamar(T, 'POST', '/v1/pedidos', { conversaId: CONV }).then((r) => r.json())).id
    const ped = (await chamar(T, 'GET', `/v1/pedidos/${id}`)).json() as { contatoId: string | null; contato: string | null }
    expect(ped.contatoId).toBe(C1)
    expect(ped.contato).toBe('Cliente MP')
    // E aparece na lista de rascunhos do próprio contato.
    const lista = (await chamar(T, 'GET', `/v1/contatos/${C1}/pedidos`)).json() as { itens: { id: string }[] }
    expect(lista.itens.map((i) => i.id)).toContain(id)
  })
})

describe('Catálogo filtrado e paginado', () => {
  it('filtra por cor e por categoria', async () => {
    const azul = (await chamar(T, 'GET', '/v1/catalogo/busca?cor=Azul')).json() as { itens: { referencia: string }[] }
    expect(azul.itens.map((i) => i.referencia)).toEqual(['REF-A'])
    const calcas = (await chamar(T, 'GET', '/v1/catalogo/busca?categoria=Calças')).json() as { itens: { referencia: string }[] }
    expect(calcas.itens.map((i) => i.referencia)).toEqual(['REF-B'])
  })

  it('expõe os valores dos filtros (cor, tamanho, categoria)', async () => {
    const f = (await chamar(T, 'GET', '/v1/catalogo/filtros')).json() as { cores: string[]; tamanhos: string[]; categorias: string[] }
    expect(f.cores).toEqual(expect.arrayContaining(['Azul', 'Preto']))
    expect(f.tamanhos).toEqual(expect.arrayContaining(['42', 'M']))
    expect(f.categorias).toEqual(expect.arrayContaining(['Calças', 'Camisas']))
  })

  it('⚠️ isolamento: catálogo de um tenant não vaza para outro (RLS)', async () => {
    const r = (await chamar(OUTRO, 'GET', '/v1/catalogo/busca')).json() as { itens: unknown[] }
    expect(r.itens.length).toBe(0)
  })
})
