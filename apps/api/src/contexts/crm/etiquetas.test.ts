import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'

/**
 * A4 — etiquetas e origens. Fixa: CRUD, papel (vendedor lê, não escreve), nome duplicado → 409,
 * isolamento entre tenants (RLS), etiqueta de outro tenant no PUT → 422, FK composta de origem.
 * Em dev o sub é `dev-<tenant>` (header x-tenant-id): é a linha de `usuario` com esse sub que ganha o papel.
 */
const T = 'a4e00000-0000-4000-8000-000000000001'
const OUTRO = 'a4e00000-0000-4000-8000-000000000002'
const PV = 'a4e00000-1111-4000-8000-000000000001'
const PV2 = 'a4e00000-1111-4000-8000-000000000002'
const PLANO = 'a4e00000-3333-4000-8000-000000000001'
const MODELO = 'a4e00000-4444-4000-8000-000000000001'
const U_T = 'a4e00000-5555-4000-8000-000000000001'
const U_ADMIN = 'a4e00000-5555-4000-8000-000000000002'
const U_OUTRO = 'a4e00000-5555-4000-8000-000000000003'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
let CONTATO = ''
const chamar = (t: string, m: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, corpo?: Record<string, unknown>) =>
  app.inject({ method: m, url, headers: { 'x-tenant-id': t }, ...(corpo ? { payload: corpo } : {}) })
const papelDe = (t: string, u: string, p: string) =>
  dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES (${t}, ${u}, NULL, ${p})
       ON CONFLICT (tenant_id, usuario_id) WHERE filial_id IS NULL DO UPDATE SET papel = EXCLUDED.papel`

async function limpar() {
  for (const tb of ['contato_etiqueta', 'contato', 'etiqueta', 'origem']) {
    await dono.unsafe(`DELETE FROM ${tb} WHERE tenant_id IN ('${T}', '${OUTRO}')`)
  }
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-a4e', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-a4e', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'A'], [OUTRO, PV2, 'B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${T}, ${U_T}, ${'dev-' + T}, 'Vera', 'vera@a4.test') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${T}, ${U_ADMIN}, 'sub-admin-a4', 'Ada', 'ada@a4.test') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${OUTRO}, ${U_OUTRO}, ${'dev-' + OUTRO}, 'Beto', 'beto@a4.test') ON CONFLICT DO NOTHING`
  await papelDe(T, U_ADMIN, 'admin') // tira o tenant do modo fundador
  await papelDe(OUTRO, U_OUTRO, 'admin')
  app = await criarApp(); await app.ready()
})

beforeEach(async () => {
  await limpar()
  await papelDe(T, U_T, 'gestor')
  CONTATO = randomUUID()
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES (${T}, ${CONTATO}, 'Zé', 'teste', true)`
})

afterAll(async () => {
  await limpar()
  await dono`DELETE FROM usuario_filial WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM usuario WHERE tenant_id IN (${T}, ${OUTRO})`
  for (const t of [T, OUTRO]) {
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('etiquetas — CRUD', () => {
  it('cria, lista, edita e desativa', async () => {
    const c = await chamar(T, 'POST', '/v1/etiquetas', { nome: 'VIP', cor: 'sucesso' })
    expect(c.statusCode).toBe(201)
    const e = c.json() as { id: string; nome: string; cor: string; ativa: boolean }
    expect(e).toMatchObject({ nome: 'VIP', cor: 'sucesso', ativa: true })

    const p = await chamar(T, 'PATCH', `/v1/etiquetas/${e.id}`, { nome: 'VIP ouro', cor: 'atencao' })
    expect(p.json()).toMatchObject({ nome: 'VIP ouro', cor: 'atencao', ativa: true })
    const d = await chamar(T, 'PATCH', `/v1/etiquetas/${e.id}`, { ativa: false })
    expect(d.json()).toMatchObject({ nome: 'VIP ouro', ativa: false })

    const todas = (await chamar(T, 'GET', '/v1/etiquetas')).json() as { itens: unknown[]; proximoCursor: string | null }
    expect(todas.itens).toHaveLength(1)
    expect(todas.proximoCursor).toBeNull()
    expect(((await chamar(T, 'GET', '/v1/etiquetas?ativas=true')).json() as { itens: unknown[] }).itens).toHaveLength(0)
  })

  it('valida: nome vazio/longo e cor fora da paleta → 422; inexistente → 404', async () => {
    expect((await chamar(T, 'POST', '/v1/etiquetas', { nome: '  ' })).statusCode).toBe(422)
    expect((await chamar(T, 'POST', '/v1/etiquetas', { nome: 'x'.repeat(41) })).statusCode).toBe(422)
    const r = await chamar(T, 'POST', '/v1/etiquetas', { nome: 'Ok', cor: '#ff0000' })
    expect(r.statusCode).toBe(422)
    expect(r.json()).toMatchObject({ erro: 'etiqueta.cor_invalida' })
    expect((await chamar(T, 'PATCH', `/v1/etiquetas/${randomUUID()}`, { ativa: false })).statusCode).toBe(404)
  })

  it('nome duplicado (sem caixa) → 409 tipificado, também no PATCH', async () => {
    await chamar(T, 'POST', '/v1/etiquetas', { nome: 'Quente' })
    const dup = await chamar(T, 'POST', '/v1/etiquetas', { nome: 'quENte' })
    expect(dup.statusCode).toBe(409)
    expect(dup.json()).toMatchObject({ erro: 'etiqueta.nome_duplicado' })
    const outra = (await chamar(T, 'POST', '/v1/etiquetas', { nome: 'Frio' })).json() as { id: string }
    expect((await chamar(T, 'PATCH', `/v1/etiquetas/${outra.id}`, { nome: 'QUENTE' })).statusCode).toBe(409)
  })

  it('lista por cursor sem repetir nem perder (60 itens, páginas de 50)', async () => {
    for (let i = 0; i < 60; i++) {
      await dono`INSERT INTO etiqueta (tenant_id, id, nome) VALUES (${T}, ${randomUUID()}, ${'e' + String(i).padStart(2, '0')})`
    }
    const p1 = (await chamar(T, 'GET', '/v1/etiquetas')).json() as { itens: { id: string }[]; proximoCursor: string }
    expect(p1.itens).toHaveLength(50)
    const p2 = (await chamar(T, 'GET', `/v1/etiquetas?cursor=${p1.proximoCursor}`)).json() as { itens: { id: string }[]; proximoCursor: string | null }
    expect(p2.itens).toHaveLength(10)
    expect(p2.proximoCursor).toBeNull()
    expect(new Set([...p1.itens, ...p2.itens].map((i) => i.id)).size).toBe(60)
    expect((await chamar(T, 'GET', '/v1/etiquetas?cursor=lixo')).statusCode).toBe(422)
  })
})

describe('papel e isolamento', () => {
  it('vendedor lê mas não escreve (403); gestor e admin escrevem', async () => {
    const e = (await chamar(T, 'POST', '/v1/etiquetas', { nome: 'Base' })).json() as { id: string }
    await papelDe(T, U_T, 'vendedor')
    expect((await chamar(T, 'GET', '/v1/etiquetas')).statusCode).toBe(200)
    expect((await chamar(T, 'GET', '/v1/origens')).statusCode).toBe(200)
    expect((await chamar(T, 'POST', '/v1/etiquetas', { nome: 'Nova' })).statusCode).toBe(403)
    expect((await chamar(T, 'PATCH', `/v1/etiquetas/${e.id}`, { ativa: false })).statusCode).toBe(403)
    expect((await chamar(T, 'POST', '/v1/origens', { nome: 'Feira' })).statusCode).toBe(403)
    await papelDe(T, U_T, 'admin')
    expect((await chamar(T, 'POST', '/v1/etiquetas', { nome: 'Nova' })).statusCode).toBe(201)
  })

  it('um tenant não vê nem altera etiqueta/origem de outro (RLS)', async () => {
    const e = (await chamar(T, 'POST', '/v1/etiquetas', { nome: 'Só da A' })).json() as { id: string }
    const o = (await chamar(T, 'POST', '/v1/origens', { nome: 'Só da A' })).json() as { id: string }
    expect(((await chamar(OUTRO, 'GET', '/v1/etiquetas')).json() as { itens: unknown[] }).itens).toHaveLength(0)
    expect(((await chamar(OUTRO, 'GET', '/v1/origens')).json() as { itens: unknown[] }).itens).toHaveLength(0)
    expect((await chamar(OUTRO, 'PATCH', `/v1/etiquetas/${e.id}`, { ativa: false })).statusCode).toBe(404)
    expect((await chamar(OUTRO, 'PATCH', `/v1/origens/${o.id}`, { ativa: false })).statusCode).toBe(404)
    // O mesmo nome vale em outro tenant (unicidade é composta com o tenant).
    expect((await chamar(OUTRO, 'POST', '/v1/etiquetas', { nome: 'Só da A' })).statusCode).toBe(201)
  })
})

describe('origens', () => {
  it('cria, ordena por ordem, edita, desativa; duplicado → 409', async () => {
    await chamar(T, 'POST', '/v1/origens', { nome: 'Indicação', ordem: 2 })
    const b = (await chamar(T, 'POST', '/v1/origens', { nome: 'Site', ordem: 1 })).json() as { id: string }
    const dup = await chamar(T, 'POST', '/v1/origens', { nome: 'site' })
    expect(dup.statusCode).toBe(409)
    expect(dup.json()).toMatchObject({ erro: 'origem.nome_duplicado' })
    expect((await chamar(T, 'POST', '/v1/origens', { nome: 'X', ordem: -1 })).statusCode).toBe(422)

    const lista = (await chamar(T, 'GET', '/v1/origens')).json() as { itens: { nome: string }[] }
    expect(lista.itens.map((i) => i.nome)).toEqual(['Site', 'Indicação'])

    const p = await chamar(T, 'PATCH', `/v1/origens/${b.id}`, { nome: 'Site novo', ordem: 5, ativa: false })
    expect(p.json()).toMatchObject({ nome: 'Site novo', ordem: 5, ativa: false })
  })

  it('FK composta: contato não aponta para origem de outro tenant; origem em uso não some', async () => {
    const o = (await chamar(T, 'POST', '/v1/origens', { nome: 'Feira' })).json() as { id: string }
    await dono`UPDATE contato SET origem_id = ${o.id} WHERE tenant_id = ${T} AND id = ${CONTATO}`
    const alheia = randomUUID()
    await dono`INSERT INTO origem (tenant_id, id, nome) VALUES (${OUTRO}, ${alheia}, 'Alheia')`
    await expect(dono`UPDATE contato SET origem_id = ${alheia} WHERE tenant_id = ${T} AND id = ${CONTATO}`).rejects.toThrow(/contato_origem_fk/)
    await expect(dono`DELETE FROM origem WHERE tenant_id = ${T} AND id = ${o.id}`).rejects.toThrow(/contato_origem_fk/)
  })
})

describe('etiquetas do contato', () => {
  it('PUT substitui o conjunto; GET devolve; vazio limpa', async () => {
    const a = (await chamar(T, 'POST', '/v1/etiquetas', { nome: 'A' })).json() as { id: string }
    const b = (await chamar(T, 'POST', '/v1/etiquetas', { nome: 'B', cor: 'erro' })).json() as { id: string }
    expect((await chamar(T, 'PUT', `/v1/contatos/${CONTATO}/etiquetas`, { etiquetaIds: [a.id, b.id, a.id] })).statusCode).toBe(200)
    let g = (await chamar(T, 'GET', `/v1/contatos/${CONTATO}/etiquetas`)).json() as { itens: { id: string }[] }
    expect(g.itens.map((i) => i.id)).toEqual([a.id, b.id])
    await chamar(T, 'PUT', `/v1/contatos/${CONTATO}/etiquetas`, { etiquetaIds: [b.id] })
    g = (await chamar(T, 'GET', `/v1/contatos/${CONTATO}/etiquetas`)).json() as { itens: { id: string }[] }
    expect(g.itens.map((i) => i.id)).toEqual([b.id])
    await chamar(T, 'PUT', `/v1/contatos/${CONTATO}/etiquetas`, { etiquetaIds: [] })
    expect(((await chamar(T, 'GET', `/v1/contatos/${CONTATO}/etiquetas`)).json() as { itens: unknown[] }).itens).toHaveLength(0)
  })

  it('etiqueta de outro tenant, inativa ou inexistente → 422 e nada é gravado', async () => {
    const minha = (await chamar(T, 'POST', '/v1/etiquetas', { nome: 'Minha' })).json() as { id: string }
    const alheia = (await chamar(OUTRO, 'POST', '/v1/etiquetas', { nome: 'Alheia' })).json() as { id: string }
    const inativa = (await chamar(T, 'POST', '/v1/etiquetas', { nome: 'Velha' })).json() as { id: string }
    await chamar(T, 'PATCH', `/v1/etiquetas/${inativa.id}`, { ativa: false })

    for (const ruim of [alheia.id, inativa.id, randomUUID()]) {
      const r = await chamar(T, 'PUT', `/v1/contatos/${CONTATO}/etiquetas`, { etiquetaIds: [minha.id, ruim] })
      expect(r.statusCode).toBe(422)
      expect(r.json()).toMatchObject({ erro: 'etiqueta.inexistente', etiquetaIds: [ruim] })
    }
    expect(((await chamar(T, 'GET', `/v1/contatos/${CONTATO}/etiquetas`)).json() as { itens: unknown[] }).itens).toHaveLength(0)
    expect((await chamar(T, 'PUT', `/v1/contatos/${CONTATO}/etiquetas`, { etiquetaIds: 'x' })).statusCode).toBe(422)
  })

  it('etiqueta desativada depois de vinculada não trava o salvamento; contato alheio → 404', async () => {
    const a = (await chamar(T, 'POST', '/v1/etiquetas', { nome: 'A' })).json() as { id: string }
    const b = (await chamar(T, 'POST', '/v1/etiquetas', { nome: 'B' })).json() as { id: string }
    await chamar(T, 'PUT', `/v1/contatos/${CONTATO}/etiquetas`, { etiquetaIds: [a.id] })
    await chamar(T, 'PATCH', `/v1/etiquetas/${a.id}`, { ativa: false })
    expect((await chamar(T, 'PUT', `/v1/contatos/${CONTATO}/etiquetas`, { etiquetaIds: [a.id, b.id] })).statusCode).toBe(200)
    expect((await chamar(OUTRO, 'PUT', `/v1/contatos/${CONTATO}/etiquetas`, { etiquetaIds: [] })).statusCode).toBe(404)
    expect((await chamar(OUTRO, 'GET', `/v1/contatos/${CONTATO}/etiquetas`)).statusCode).toBe(404)
  })

  it('RLS: contato_etiqueta de um tenant não aparece para o outro', async () => {
    const a = (await chamar(T, 'POST', '/v1/etiquetas', { nome: 'A' })).json() as { id: string }
    await chamar(T, 'PUT', `/v1/contatos/${CONTATO}/etiquetas`, { etiquetaIds: [a.id] })
    const linhas = await dono<{ n: string }[]>`SELECT count(*)::text AS n FROM contato_etiqueta WHERE tenant_id = ${T}`
    expect(linhas[0]?.n).toBe('1')
    // FK composta: vínculo cruzado entre tenants é rejeitado no banco.
    await expect(dono`INSERT INTO contato_etiqueta (tenant_id, contato_id, etiqueta_id) VALUES (${OUTRO}, ${CONTATO}, ${a.id})`).rejects.toThrow()
  })
})

describe('etiquetas e origens — busca ?q= no servidor', () => {
  const nomesEtiquetas = async (qs: string, t = T): Promise<string[]> =>
    ((await chamar(t, 'GET', `/v1/etiquetas${qs}`)).json() as { itens: { nome: string }[] }).itens.map((i) => i.nome).sort()
  const nomesOrigens = async (qs: string, t = T): Promise<string[]> =>
    ((await chamar(t, 'GET', `/v1/origens${qs}`)).json() as { itens: { nome: string }[] }).itens.map((i) => i.nome).sort()

  it('etiquetas: q casa parte do nome sem caixa, espaços não filtram, combina com ativas', async () => {
    await chamar(T, 'POST', '/v1/etiquetas', { nome: 'Cliente VIP' })
    await chamar(T, 'POST', '/v1/etiquetas', { nome: 'vip_antigo' })
    await chamar(T, 'POST', '/v1/etiquetas', { nome: 'Frio 100%' })
    const inativa = (await chamar(T, 'POST', '/v1/etiquetas', { nome: 'VIP desativada' })).json() as { id: string }
    await chamar(T, 'PATCH', `/v1/etiquetas/${inativa.id}`, { ativa: false })
    expect(await nomesEtiquetas('?q=vip')).toEqual(['Cliente VIP', 'VIP desativada', 'vip_antigo'])
    expect(await nomesEtiquetas('?q=vip&ativas=true')).toEqual(['Cliente VIP', 'vip_antigo'])
    expect(await nomesEtiquetas('?q=%20')).toEqual(['Cliente VIP', 'Frio 100%', 'VIP desativada', 'vip_antigo'])
  })

  it('etiquetas: escapa % e _ no q; o isolamento vale com o filtro', async () => {
    await chamar(T, 'POST', '/v1/etiquetas', { nome: 'vip_antigo' })
    await chamar(T, 'POST', '/v1/etiquetas', { nome: 'vipxantigo' })
    await chamar(T, 'POST', '/v1/etiquetas', { nome: 'Frio 100%' })
    await chamar(OUTRO, 'POST', '/v1/etiquetas', { nome: 'Cliente VIP de outro' })
    expect(await nomesEtiquetas('?q=_a')).toEqual(['vip_antigo'])
    expect(await nomesEtiquetas('?q=%25')).toEqual(['Frio 100%'])
    expect(await nomesEtiquetas('?q=%5C')).toEqual([])
    expect(await nomesEtiquetas('?q=VIP', OUTRO)).toEqual(['Cliente VIP de outro'])
  })

  it('origens: q casa parte do nome, escapa %/_, e o isolamento vale com o filtro', async () => {
    await chamar(T, 'POST', '/v1/origens', { nome: 'Feira_norte', ordem: 1 })
    await chamar(T, 'POST', '/v1/origens', { nome: 'Feira sul', ordem: 2 })
    await chamar(T, 'POST', '/v1/origens', { nome: 'Indicação 50%', ordem: 3 })
    await chamar(OUTRO, 'POST', '/v1/origens', { nome: 'Feira do outro', ordem: 1 })
    expect(await nomesOrigens('?q=FEIRA')).toEqual(['Feira sul', 'Feira_norte'])
    expect(await nomesOrigens('?q=_n')).toEqual(['Feira_norte'])
    expect(await nomesOrigens('?q=%25')).toEqual(['Indicação 50%'])
    expect(await nomesOrigens('?q=%20%20')).toEqual(['Feira sul', 'Feira_norte', 'Indicação 50%'])
    expect(await nomesOrigens('?q=feira', OUTRO)).toEqual(['Feira do outro'])
  })

  it('origens: cursor e q andam juntos em duas páginas, sem repetir nem pular', async () => {
    for (let i = 1; i <= 55; i++) await chamar(T, 'POST', '/v1/origens', { nome: `Origem ${String(i).padStart(2, '0')}`, ordem: 0 })
    await chamar(T, 'POST', '/v1/origens', { nome: 'Outra', ordem: 0 })
    const vistos: string[] = []
    let cursor: string | null = null
    let paginas = 0
    do {
      const qs = `?q=origem${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const j = (await chamar(T, 'GET', `/v1/origens${qs}`)).json() as { itens: { nome: string }[]; proximoCursor: string | null }
      vistos.push(...j.itens.map((i) => i.nome))
      cursor = j.proximoCursor
      paginas++
    } while (cursor)
    expect(paginas).toBe(2)
    expect(new Set(vistos).size).toBe(55)
    expect(vistos.every((n) => n.startsWith('Origem '))).toBe(true)
  })

  it('q longo demais → 422 com campos.q, em etiquetas e origens', async () => {
    const longo = `?q=${'a'.repeat(101)}`
    for (const rota of ['/v1/etiquetas', '/v1/origens']) {
      const r = await chamar(T, 'GET', `${rota}${longo}`)
      expect(r.statusCode, rota).toBe(422)
      expect(r.json(), rota).toMatchObject({ erro: 'busca.invalida', campos: { q: expect.any(String) } })
    }
  })
})
