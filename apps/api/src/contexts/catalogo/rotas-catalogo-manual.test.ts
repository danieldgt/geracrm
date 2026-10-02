import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'

/**
 * CRUD do catálogo manual pela API (ADR-025), com DOIS tenants — o bloco de
 * isolamento é o mais importante do arquivo. A API conecta com o papel da
 * aplicação (DATABASE_URL), então o que passa aqui passa pela RLS.
 *
 * ⚠️ UUIDs e códigos de semente exclusivos deste arquivo.
 */
const TA = 'ca7a1090-0000-4000-8000-000000000001'
const TB = 'ca7a1090-0000-4000-8000-000000000002'
const PVA = 'ca7a1090-1111-4000-8000-000000000001'
const PVB = 'ca7a1090-1111-4000-8000-000000000002'
const PLANO = 'ca7a1090-3333-4000-8000-000000000001'
const MODELO = 'ca7a1090-4444-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance

type Metodo = 'GET' | 'POST' | 'PATCH' | 'DELETE'
const como = (tenant: string) => (m: Metodo, url: string, corpo?: unknown) =>
  app.inject({ method: m, url, headers: { 'x-tenant-id': tenant }, ...(corpo !== undefined ? { payload: corpo as Record<string, unknown> } : {}) })
const A = como(TA)
const B = como(TB)

const camiseta = {
  referencia: 'CAM-01', descricao: 'Camiseta básica', categoria: 'Camisetas',
  descricaoLonga: 'Algodão penteado.', imagens: ['https://cdn.exemplo.com/cam-01.jpg'],
  skus: [
    { atributos: { cor: 'VERDE', tamanho: 'G' }, precos: { varejo: 4990, atacado: 2990 }, saldo: 10 },
    { atributos: { cor: 'VERDE', tamanho: 'M' }, precos: { varejo: 4990 }, saldo: null },
  ],
}

async function criarCamiseta(ref = 'CAM-01'): Promise<{ id: string; skus: { id: string }[] }> {
  const r = await A('POST', '/v1/catalogo/produtos', { ...camiseta, referencia: ref })
  expect(r.statusCode, r.body).toBe(201)
  return r.json()
}

/** Produto que "veio do ERP": inserido como dono, com origem erp. */
async function produtoDoErp(): Promise<{ produto: string; sku: string }> {
  const produto = randomUUID(), sku = randomUUID()
  await dono`INSERT INTO produto (tenant_id, id, referencia, descricao, origem) VALUES (${TA}, ${produto}, 'ERP-LAILA', 'CONJUNTO LAILA', 'erp')`
  await dono`INSERT INTO sku (tenant_id, id, produto_id, atributos, origem) VALUES (${TA}, ${sku}, ${produto}, '{"cor":"AZUL","tamanho":"P"}'::jsonb, 'erp')`
  return { produto, sku }
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-catalogo-rotas', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-catalogo-rotas', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    for (const [t, pv, nome] of [[TA, PVA, 'Loja A'], [TB, PVB, 'Loja B']] as const) {
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    }
  })
  app = await criarApp(); await app.ready()
})

beforeEach(async () => {
  await dono`DELETE FROM produto WHERE tenant_id IN (${TA}, ${TB})`
})

afterAll(async () => {
  for (const t of [TA, TB]) {
    await dono`DELETE FROM produto WHERE tenant_id = ${t}`
    await dono`DELETE FROM tabela_preco WHERE tenant_id = ${t}`
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('POST /v1/catalogo/produtos', () => {
  it('dado produto com grade, preço por perfil e saldo, então cria tudo e indexa', async () => {
    const { id, skus } = await criarCamiseta()
    expect(skus).toHaveLength(2)

    const [p] = await dono<{ origem: string; imagens: string[]; descricao_longa: string }[]>`SELECT origem, imagens, descricao_longa FROM produto WHERE tenant_id = ${TA} AND id = ${id}`
    expect(p).toEqual({ origem: 'manual', imagens: ['https://cdn.exemplo.com/cam-01.jpg'], descricao_longa: 'Algodão penteado.' })
    const [s] = await dono<{ tipo: string; origem: string }[]>`SELECT jsonb_typeof(atributos) AS tipo, origem FROM sku WHERE tenant_id = ${TA} AND id = ${skus[0]!.id}`
    expect(s).toEqual({ tipo: 'object', origem: 'manual' })
    const precos = await dono<{ tabela_externa: string; preco: string }[]>`SELECT tabela_externa, preco_centavos::text AS preco FROM sku_preco WHERE tenant_id = ${TA} AND sku_id = ${skus[0]!.id} ORDER BY 1`
    expect(precos).toEqual([{ tabela_externa: 'atacado', preco: '2990' }, { tabela_externa: 'varejo', preco: '4990' }])
    const tabelas = await dono<{ perfil: string }[]>`SELECT perfil FROM tabela_preco WHERE tenant_id = ${TA} AND sistema = 'manual' ORDER BY 1`
    expect(tabelas).toEqual([{ perfil: 'atacado' }, { perfil: 'varejo' }])
    const [saldo] = await dono<{ quantidade: string; origem: string }[]>`SELECT quantidade::text, origem FROM sku_saldo WHERE tenant_id = ${TA} AND sku_id = ${skus[0]!.id}`
    expect(saldo).toEqual({ quantidade: '10.000', origem: 'manual' })
    const [indice] = await dono<{ texto: string }[]>`SELECT texto FROM produto_indice WHERE tenant_id = ${TA} AND produto_id = ${id}`
    expect(indice!.texto).toContain('Camiseta básica')
  })

  it('dado corpo inválido (sem descrição, preço fracionado), então 422 tipificado com os campos', async () => {
    const r = await A('POST', '/v1/catalogo/produtos', { referencia: 'X', skus: [{ precos: { varejo: 49.9 } }] })
    expect(r.statusCode).toBe(422)
    expect(r.json()).toMatchObject({ erro: 'catalogo.entrada_invalida', campos: expect.arrayContaining(['descricao', 'skus.0.precos.varejo']) })
  })

  it('dado referência repetida no tenant, então 422 catalogo.referencia_duplicada', async () => {
    await criarCamiseta()
    const r = await A('POST', '/v1/catalogo/produtos', { referencia: 'CAM-01', descricao: 'Outra' })
    expect(r.statusCode).toBe(422)
    expect(r.json()).toMatchObject({ erro: 'catalogo.referencia_duplicada' })
  })
})

describe('GET /v1/catalogo/produtos (lista por cursor) e /:id', () => {
  it('dado 35 produtos, então 30 na primeira página, 5 na segunda, sem sobreposição', async () => {
    for (let i = 0; i < 35; i++) {
      const r = await A('POST', '/v1/catalogo/produtos', { referencia: `P-${String(i).padStart(2, '0')}`, descricao: `Produto ${String(i).padStart(2, '0')}` })
      expect(r.statusCode).toBe(201)
    }
    const p1 = (await A('GET', '/v1/catalogo/produtos')).json() as { itens: { id: string }[]; proximoCursor: string | null }
    expect(p1.itens).toHaveLength(30)
    expect(p1.proximoCursor).not.toBeNull()
    const p2 = (await A('GET', `/v1/catalogo/produtos?cursor=${p1.proximoCursor}`)).json() as { itens: { id: string }[]; proximoCursor: string | null }
    expect(p2.itens).toHaveLength(5)
    expect(p2.proximoCursor).toBeNull()
    const ids1 = new Set(p1.itens.map((i) => i.id))
    expect(p2.itens.some((i) => ids1.has(i.id))).toBe(false)
  })

  it('dado cursor corrompido, então 422 cursor.invalido', async () => {
    expect((await A('GET', '/v1/catalogo/produtos?cursor=abc')).statusCode).toBe(422)
  })

  it('dado busca e filtro de origem, então filtra no banco', async () => {
    await criarCamiseta()
    await produtoDoErp()
    const manual = (await A('GET', '/v1/catalogo/produtos?origem=manual')).json() as { itens: { referencia: string }[] }
    expect(manual.itens.map((i) => i.referencia)).toEqual(['CAM-01'])
    const busca = (await A('GET', '/v1/catalogo/produtos?busca=laila')).json() as { itens: { referencia: string; origem: string }[] }
    expect(busca.itens).toEqual([expect.objectContaining({ referencia: 'ERP-LAILA', origem: 'erp' })])
  })

  it('dado ?perfil, então o preço do SKU segue o perfil; sem preço no perfil → null', async () => {
    const { id } = await criarCamiseta()
    const varejo = (await A('GET', `/v1/catalogo/produtos/${id}?perfil=varejo`)).json() as { skus: { atributos: Record<string, string>; precoCentavos: number | null; saldo: number | null }[] }
    const atacado = (await A('GET', `/v1/catalogo/produtos/${id}?perfil=atacado`)).json() as typeof varejo
    const g = (p: typeof varejo) => p.skus.find((s) => s.atributos.tamanho === 'G')!
    const m = (p: typeof varejo) => p.skus.find((s) => s.atributos.tamanho === 'M')!
    expect([g(varejo).precoCentavos, g(atacado).precoCentavos]).toEqual([4990, 2990])
    expect([m(varejo).precoCentavos, m(atacado).precoCentavos]).toEqual([4990, null])
    expect([g(varejo).saldo, m(varejo).saldo]).toEqual([10, null])
  })

  it('dado id inexistente, então 404 tipificado', async () => {
    const r = await A('GET', `/v1/catalogo/produtos/${randomUUID()}`)
    expect(r.statusCode).toBe(404)
    expect(r.json()).toMatchObject({ erro: 'catalogo.produto_nao_encontrado' })
  })
})

describe('PATCH e DELETE (soft) de produto e SKU', () => {
  it('dado PATCH de descrição e categoria, então atualiza e reindexa', async () => {
    const { id } = await criarCamiseta()
    const r = await A('PATCH', `/v1/catalogo/produtos/${id}`, { descricao: 'Camiseta premium', categoria: 'Básicos' })
    expect(r.statusCode).toBe(200)
    const [p] = await dono<{ descricao: string; categoria: string }[]>`SELECT descricao, categoria FROM produto WHERE tenant_id = ${TA} AND id = ${id}`
    expect(p).toEqual({ descricao: 'Camiseta premium', categoria: 'Básicos' })
    const [i] = await dono<{ texto: string }[]>`SELECT texto FROM produto_indice WHERE tenant_id = ${TA} AND produto_id = ${id}`
    expect(i!.texto).toContain('Camiseta premium')
  })

  it('dado PATCH de SKU com preços e saldo, então substitui os preços manuais (perfil ausente some) e o saldo', async () => {
    const { id, skus } = await criarCamiseta()
    const skuG = skus[0]!.id
    const r = await A('PATCH', `/v1/catalogo/produtos/${id}/skus/${skuG}`, { precos: { varejo: 5490 }, saldo: 3 })
    expect(r.statusCode).toBe(200)
    const precos = await dono<{ tabela_externa: string; preco: string }[]>`SELECT tabela_externa, preco_centavos::text AS preco FROM sku_preco WHERE tenant_id = ${TA} AND sku_id = ${skuG}`
    expect(precos).toEqual([{ tabela_externa: 'varejo', preco: '5490' }])
    const [saldo] = await dono<{ quantidade: string }[]>`SELECT quantidade::text FROM sku_saldo WHERE tenant_id = ${TA} AND sku_id = ${skuG}`
    expect(saldo!.quantidade).toBe('3.000')
    // saldo null = não controla estoque → a linha some
    await A('PATCH', `/v1/catalogo/produtos/${id}/skus/${skuG}`, { saldo: null })
    expect(await dono`SELECT 1 FROM sku_saldo WHERE tenant_id = ${TA} AND sku_id = ${skuG}`).toHaveLength(0)
  })

  it('dado POST de SKU novo, então entra na grade e no índice', async () => {
    const { id } = await criarCamiseta()
    const r = await A('POST', `/v1/catalogo/produtos/${id}/skus`, { atributos: { cor: 'AMARELO', tamanho: 'GG' }, precos: { varejo: 4990 } })
    expect(r.statusCode).toBe(201)
    const [i] = await dono<{ texto: string }[]>`SELECT texto FROM produto_indice WHERE tenant_id = ${TA} AND produto_id = ${id}`
    expect(i!.texto).toContain('AMARELO')
  })

  it('dado DELETE, então é soft: ativo=false, a linha fica, e some da lista padrão', async () => {
    const { id, skus } = await criarCamiseta()
    expect((await A('DELETE', `/v1/catalogo/produtos/${id}/skus/${skus[1]!.id}`)).statusCode).toBe(200)
    expect((await A('DELETE', `/v1/catalogo/produtos/${id}`)).statusCode).toBe(200)
    const [p] = await dono<{ ativo: boolean }[]>`SELECT ativo FROM produto WHERE tenant_id = ${TA} AND id = ${id}`
    expect(p!.ativo).toBe(false)
    const lista = (await A('GET', '/v1/catalogo/produtos')).json() as { itens: unknown[] }
    expect(lista.itens).toHaveLength(0)
    const comInativos = (await A('GET', '/v1/catalogo/produtos?inativos=1')).json() as { itens: { skus: { ativo: boolean }[] }[] }
    expect(comInativos.itens).toHaveLength(1)
    expect(comInativos.itens[0]!.skus.map((s) => s.ativo).sort()).toEqual([false, true])
  })

  it('dado SKU de outro produto, então 404 catalogo.sku_nao_encontrado', async () => {
    const a = await criarCamiseta('CAM-A')
    const b = await criarCamiseta('CAM-B')
    const r = await A('PATCH', `/v1/catalogo/produtos/${a.id}/skus/${b.skus[0]!.id}`, { saldo: 1 })
    expect(r.statusCode).toBe(404)
    expect(r.json()).toMatchObject({ erro: 'catalogo.sku_nao_encontrado' })
  })
})

describe('⚠️ Origem por campo: produto do ERP (ADR-008/025)', () => {
  it('dado produto do ERP, quando editar referência/descrição/ativo, então 409 catalogo.origem_erp com os campos', async () => {
    const { produto } = await produtoDoErp()
    const r = await A('PATCH', `/v1/catalogo/produtos/${produto}`, { descricao: 'Mudei', categoria: 'Conjuntos' })
    expect(r.statusCode).toBe(409)
    expect(r.json()).toMatchObject({ erro: 'catalogo.origem_erp', campos: ['descricao'] })
    const [p] = await dono<{ descricao: string; categoria: string | null }[]>`SELECT descricao, categoria FROM produto WHERE tenant_id = ${TA} AND id = ${produto}`
    expect(p).toEqual({ descricao: 'CONJUNTO LAILA', categoria: null }) // nada foi gravado
  })

  it('dado produto do ERP, quando editar só o que é nosso (descrição longa, imagens, categoria), então 200', async () => {
    const { produto } = await produtoDoErp()
    const r = await A('PATCH', `/v1/catalogo/produtos/${produto}`, { descricaoLonga: 'Conjunto de malha.', imagens: ['https://cdn.exemplo.com/laila.jpg'], categoria: 'Conjuntos' })
    expect(r.statusCode).toBe(200)
    const [p] = await dono<{ descricao_longa: string; categoria: string; origem: string }[]>`SELECT descricao_longa, categoria, origem FROM produto WHERE tenant_id = ${TA} AND id = ${produto}`
    expect(p).toEqual({ descricao_longa: 'Conjunto de malha.', categoria: 'Conjuntos', origem: 'erp' })
  })

  it('dado produto do ERP, então DELETE, SKU novo e PATCH de SKU respondem 409', async () => {
    const { produto, sku } = await produtoDoErp()
    expect((await A('DELETE', `/v1/catalogo/produtos/${produto}`)).statusCode).toBe(409)
    expect((await A('POST', `/v1/catalogo/produtos/${produto}/skus`, { atributos: { cor: 'ROSA' } })).statusCode).toBe(409)
    const r = await A('PATCH', `/v1/catalogo/produtos/${produto}/skus/${sku}`, { precos: { varejo: 1000 }, saldo: 5 })
    expect(r.statusCode).toBe(409)
    expect(r.json()).toMatchObject({ erro: 'catalogo.origem_erp', campos: expect.arrayContaining(['precos', 'saldo']) })
    expect(await dono`SELECT 1 FROM sku_preco WHERE tenant_id = ${TA} AND sku_id = ${sku}`).toHaveLength(0)
  })
})

describe('⚠️ Isolamento entre tenants (RLS, sob o papel da aplicação)', () => {
  it('dado produto do tenant A, então B não lista, não lê, não edita nem apaga — e A continua intacto', async () => {
    const { id, skus } = await criarCamiseta()

    const lista = (await B('GET', '/v1/catalogo/produtos')).json() as { itens: unknown[] }
    expect(lista.itens).toEqual([])
    expect((await B('GET', `/v1/catalogo/produtos/${id}`)).statusCode).toBe(404)
    expect((await B('PATCH', `/v1/catalogo/produtos/${id}`, { descricao: 'Invadido' })).statusCode).toBe(404)
    expect((await B('PATCH', `/v1/catalogo/produtos/${id}/skus/${skus[0]!.id}`, { saldo: 0 })).statusCode).toBe(404)
    expect((await B('POST', `/v1/catalogo/produtos/${id}/skus`, { atributos: { cor: 'X' } })).statusCode).toBe(404)
    expect((await B('DELETE', `/v1/catalogo/produtos/${id}`)).statusCode).toBe(404)

    const [p] = await dono<{ descricao: string; ativo: boolean }[]>`SELECT descricao, ativo FROM produto WHERE tenant_id = ${TA} AND id = ${id}`
    expect(p).toEqual({ descricao: 'Camiseta básica', ativo: true })
  })

  it('dado a mesma referência nos dois tenants, então cada um tem o seu (chave composta)', async () => {
    await criarCamiseta()
    const r = await B('POST', '/v1/catalogo/produtos', { referencia: 'CAM-01', descricao: 'Camiseta da B' })
    expect(r.statusCode).toBe(201)
    const [b] = await dono<{ tenant_id: string }[]>`SELECT tenant_id FROM produto WHERE id = ${(r.json() as { id: string }).id}`
    expect(b!.tenant_id).toBe(TB)
    const [ib] = await dono<{ tenant_id: string }[]>`SELECT tenant_id FROM produto_indice WHERE produto_id = ${(r.json() as { id: string }).id}`
    expect(ib!.tenant_id).toBe(TB)
  })

  it('dado reindexação pelo tenant B, então só o catálogo de B é tocado', async () => {
    await criarCamiseta()
    await dono`DELETE FROM produto_indice WHERE tenant_id = ${TA}`
    const r = await B('POST', '/v1/catalogo/reindexar')
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ indexados: 0, inalterados: 0, ausentes: 0 })
    expect(await dono`SELECT 1 FROM produto_indice WHERE tenant_id = ${TA}`).toHaveLength(0)
    expect((await A('POST', '/v1/catalogo/reindexar')).json()).toEqual({ indexados: 1, inalterados: 0, ausentes: 0 })
  })

  it('dado requisição sem tenant, então 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/catalogo/produtos' })).statusCode).toBe(401)
  })
})
