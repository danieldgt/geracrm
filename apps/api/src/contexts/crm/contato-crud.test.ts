import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'

/** Expansão de CRUDs — gestão da ficha do contato (satélites). */
const T = 'c50d0000-0000-4000-8000-000000000001'
const OUTRO = 'c50d0000-0000-4000-8000-000000000002'
const PV = 'c50d0000-1111-4000-8000-000000000001'
const PV2 = 'c50d0000-1111-4000-8000-000000000002'
const PLANO = 'c50d0000-3333-4000-8000-000000000001'
const MODELO = 'c50d0000-4444-4000-8000-000000000001'
let CONTATO = ''

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const chamar = (t: string, m: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, corpo?: Record<string, unknown>) =>
  app.inject({ method: m, url, headers: { 'x-tenant-id': t }, ...(corpo ? { payload: corpo } : {}) })

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-cc', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-cc', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'A'], [OUTRO, PV2, 'B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  app = await criarApp(); await app.ready()
})

beforeEach(async () => {
  await dono`DELETE FROM comentario WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato_telefone WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato_documento WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato_endereco WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato WHERE tenant_id = ${T}`
  CONTATO = randomUUID()
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES (${T}, ${CONTATO}, 'Zé', 'teste', true)`
})

afterAll(async () => {
  for (const tb of ['comentario', 'contato_telefone', 'contato_documento', 'contato_endereco', 'contato']) {
    await dono.unsafe(`DELETE FROM ${tb} WHERE tenant_id = '${T}'`)
  }
  for (const t of [T, OUTRO]) {
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('CRUD da ficha do contato', () => {
  it('edita nome e desativa', async () => {
    const r = await chamar(T, 'PATCH', `/v1/contatos/${CONTATO}`, { nome: 'José Silva', ativo: false })
    expect(r.statusCode).toBe(200)
    const [c] = await dono<{ nome: string; ativo: boolean }[]>`SELECT nome, ativo FROM contato WHERE tenant_id=${T} AND id=${CONTATO}`
    expect(c).toMatchObject({ nome: 'José Silva', ativo: false })
  })

  it('telefones: 1º vira principal; novo principal desmarca o anterior; remover', async () => {
    await chamar(T, 'POST', `/v1/contatos/${CONTATO}/telefones`, { telefone: '81999990000' })
    await chamar(T, 'POST', `/v1/contatos/${CONTATO}/telefones`, { telefone: '81988887777' })
    let tels = await dono<{ seq: number; principal: boolean }[]>`SELECT seq, principal FROM contato_telefone WHERE tenant_id=${T} AND contato_id=${CONTATO} ORDER BY seq`
    expect(tels.map((t) => t.principal)).toEqual([true, false]) // 1º é principal
    await chamar(T, 'POST', `/v1/contatos/${CONTATO}/telefones/${tels[1]!.seq}/principal`)
    tels = await dono`SELECT seq, principal FROM contato_telefone WHERE tenant_id=${T} AND contato_id=${CONTATO} ORDER BY seq`
    expect(tels.map((t: { principal: boolean }) => t.principal)).toEqual([false, true]) // trocou
    await chamar(T, 'DELETE', `/v1/contatos/${CONTATO}/telefones/${tels[0]!.seq}`)
    const [n] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM contato_telefone WHERE tenant_id=${T} AND contato_id=${CONTATO}`
    expect(n!.n).toBe(1)
  })

  it('⚠️ documento inválido (dígito) → 422; válido grava', async () => {
    const ruim = await chamar(T, 'POST', `/v1/contatos/${CONTATO}/documentos`, { tipo: 'cnpj', numero: '11222333000180' })
    expect(ruim.statusCode).toBe(422)
    const bom = await chamar(T, 'POST', `/v1/contatos/${CONTATO}/documentos`, { tipo: 'cnpj', numero: '11.222.333/0001-81' })
    expect(bom.statusCode).toBe(201)
    const [d] = await dono<{ numero: string }[]>`SELECT numero FROM contato_documento WHERE tenant_id=${T} AND contato_id=${CONTATO}`
    expect(d!.numero).toBe('11222333000181')
  })

  it('endereço: upsert (um principal)', async () => {
    await chamar(T, 'PUT', `/v1/contatos/${CONTATO}/endereco`, { logradouro: 'Rua A', numero: '10', cidade: 'Recife', uf: 'PE', cep: '50000000' })
    await chamar(T, 'PUT', `/v1/contatos/${CONTATO}/endereco`, { logradouro: 'Rua B', cidade: 'Olinda', uf: 'PE' })
    const linhas = await dono<{ logradouro: string }[]>`SELECT logradouro FROM contato_endereco WHERE tenant_id=${T} AND contato_id=${CONTATO}`
    expect(linhas.length).toBe(1) // upsert, não duplica
    expect(linhas[0]!.logradouro).toBe('Rua B')
  })

  it('comentários: adiciona e lista', async () => {
    await chamar(T, 'POST', `/v1/contatos/${CONTATO}/comentarios`, { texto: 'Cliente pediu desconto' })
    const l = await chamar(T, 'GET', `/v1/contatos/${CONTATO}/comentarios`)
    const itens = (l.json() as { itens: { texto: string }[] }).itens
    expect(itens.length).toBe(1)
    expect(itens[0]!.texto).toBe('Cliente pediu desconto')
    const vazio = await chamar(T, 'POST', `/v1/contatos/${CONTATO}/comentarios`, { texto: '  ' })
    expect(vazio.statusCode).toBe(422)
  })

  it('⚠️ isolamento: PATCH em contato de outro tenant → 404', async () => {
    const r = await chamar(OUTRO, 'PATCH', `/v1/contatos/${CONTATO}`, { nome: 'invasor' })
    expect(r.statusCode).toBe(404)
  })
})

describe('Lista de contatos: quem nunca comprou também aparece', () => {
  /**
   * ⚠️ O caso real: 709 confecções importadas para prospecção, a busca as
   * encontrava, o kanban contava as 709, e a tela "Contatos" mostrava vazio —
   * porque a consulta era INNER JOIN com `metricas_contato`, e só há métrica
   * para quem já comprou. Quem prospecta começa sem venda nenhuma.
   */
  it('contato sem venda entra na lista, com zeros', async () => {
    const id = randomUUID()
    await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo)
               VALUES (${T}, ${id}, 'Confecção Sem Compra', 'importacao', true)`

    const r = await chamar(T, 'GET', '/v1/contatos')
    expect(r.statusCode).toBe(200)
    const itens = r.json<{ itens: { id: string; nome: string; qtdVendas: number; totalCentavos: number }[] }>().itens
    const achado = itens.find((c) => c.id === id)
    expect(achado?.nome).toBe('Confecção Sem Compra')
    expect(achado?.qtdVendas).toBe(0)
    expect(achado?.totalCentavos).toBe(0)

    await dono`DELETE FROM contato WHERE tenant_id = ${T} AND id = ${id}`
  })

  it('⚠️ não vaza contato de outro tenant', async () => {
    const id = randomUUID()
    await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo)
               VALUES (${OUTRO}, ${id}, 'Segredo do B', 'importacao', true)`

    const itens = (await chamar(T, 'GET', '/v1/contatos'))
      .json<{ itens: { nome: string }[] }>().itens
    expect(itens.map((c) => c.nome)).not.toContain('Segredo do B')

    await dono`DELETE FROM contato WHERE tenant_id = ${OUTRO} AND id = ${id}`
  })
})

