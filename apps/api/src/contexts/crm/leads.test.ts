import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'

/** CRM (Leads): colunas por qualificação, card com telefone/uf/responsável/conversa,
 *  qualificar move entre colunas (coerência do CHECK), isolamento por tenant. */
const T = 'ead00000-0000-4000-8000-000000000001'
const OUTRO = 'ead00000-0000-4000-8000-000000000002'
const PV = 'ead00000-1111-4000-8000-000000000001'
const PV2 = 'ead00000-1111-4000-8000-000000000002'
const PLANO = 'ead00000-3333-4000-8000-000000000001'
const MODELO = 'ead00000-4444-4000-8000-000000000001'
const U = 'ead00000-5555-4000-8000-000000000001'
const CANAL = 'ead00000-7777-4000-8000-000000000001'
const C_NOVO = 'ead00000-6666-4000-8000-000000000001'
const C_QUAL = 'ead00000-6666-4000-8000-000000000002'
const C_DESC = 'ead00000-6666-4000-8000-000000000003'
const C_OFF = 'ead00000-6666-4000-8000-000000000004'
const CONV = 'ead00000-8888-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const chamar = (t: string, m: 'GET' | 'POST', url: string, corpo?: Record<string, unknown>) =>
  app.inject({ method: m, url, headers: { 'x-tenant-id': t }, ...(corpo ? { payload: corpo } : {}) })

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-leads', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-leads', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'A'], [OUTRO, PV2, 'B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${T}, ${U}, 'sub-leads-u', 'Duda', 'duda@x.com') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES (${T}, ${CANAL}, 'whatsapp_oficial', 'Zap', 'conectado') ON CONFLICT DO NOTHING`
  app = await criarApp(); await app.ready()
})

beforeEach(async () => {
  await dono`DELETE FROM conversa WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM carteira_atribuicao WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM contato_telefone WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM contato_endereco WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM contato WHERE tenant_id IN (${T}, ${OUTRO})`
  // Lead novo (não avaliado) COM telefone, UF, responsável e conversa.
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES (${T}, ${C_NOVO}, 'Maria Nova', 'teste', true)`
  await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, fonte) VALUES (${T}, ${C_NOVO}, 1, '+5581999990001', '5581999990001', true, 'manual')`
  await dono`INSERT INTO contato_endereco (tenant_id, contato_id, seq, uf, principal, fonte) VALUES (${T}, ${C_NOVO}, 1, 'PE', true, 'manual')`
  await dono`INSERT INTO carteira_atribuicao (tenant_id, id, contato_id, usuario_id, origem) VALUES (${T}, ${randomUUID()}, ${C_NOVO}, ${U}, 'manual')`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, ultima_direcao, ultima_mensagem_em) VALUES (${T}, ${CONV}, ${CANAL}, ${C_NOVO}, 'entrante', now())`
  // Qualificado e descartado (qualificado_em coerente com o CHECK).
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo, qualificado, qualificado_em) VALUES (${T}, ${C_QUAL}, 'João Bom', 'teste', true, true, now())`
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo, qualificado, qualificado_em) VALUES (${T}, ${C_DESC}, 'Zé Frio', 'teste', true, false, now())`
  // Inativo: nunca aparece.
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES (${T}, ${C_OFF}, 'Sumido', 'teste', false)`
})

afterAll(async () => {
  await dono`DELETE FROM conversa WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM carteira_atribuicao WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM contato_telefone WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM contato_endereco WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM contato WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM canal_conectado WHERE tenant_id IN (${T}, ${OUTRO})`
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

type Colunas = { colunas: { chave: string; nome: string; total: number }[] }
const colunas = async (t: string) => (await chamar(t, 'GET', '/v1/leads/colunas')).json() as Colunas
const total = (c: Colunas, chave: string) => c.colunas.find((x) => x.chave === chave)!.total

describe('CRM (Leads)', () => {
  it('colunas contam por qualificação; inativo não entra', async () => {
    const c = await colunas(T)
    expect(c.colunas.map((x) => x.chave)).toEqual(['novo', 'qualificado', 'descartado'])
    expect(total(c, 'novo')).toBe(1)
    expect(total(c, 'qualificado')).toBe(1)
    expect(total(c, 'descartado')).toBe(1)
  })

  it('card do lead novo traz telefone, uf, responsável e conversa (sem conteúdo)', async () => {
    const col = (await chamar(T, 'GET', '/v1/leads/coluna/novo')).json() as {
      itens: { contatoId: string; nome: string; telefone: string; uf: string; responsavel: string; conversaId: string; conteudo?: unknown }[]
    }
    expect(col.itens.length).toBe(1)
    expect(col.itens[0]).toMatchObject({
      nome: 'Maria Nova', telefone: '+5581999990001', uf: 'PE', responsavel: 'Duda', conversaId: CONV,
    })
    expect('conteudo' in col.itens[0]!).toBe(false)
  })

  it('qualificar move o lead entre colunas e mantém coerência (novo→qualificado→novo)', async () => {
    expect((await chamar(T, 'POST', `/v1/leads/${C_NOVO}/qualificar`, { estado: 'qualificado' })).statusCode).toBe(200)
    let c = await colunas(T)
    expect(total(c, 'novo')).toBe(0)
    expect(total(c, 'qualificado')).toBe(2)
    const [a] = await dono<{ qualificado: boolean; qualificado_em: Date | null }[]>`
      SELECT qualificado, qualificado_em FROM contato WHERE tenant_id = ${T} AND id = ${C_NOVO}`
    expect(a!.qualificado).toBe(true)
    expect(a!.qualificado_em).not.toBeNull()

    // Voltar para 'novo' zera qualificado_em (CHECK contato_qualificacao_coerente).
    expect((await chamar(T, 'POST', `/v1/leads/${C_NOVO}/qualificar`, { estado: 'novo' })).statusCode).toBe(200)
    c = await colunas(T)
    expect(total(c, 'novo')).toBe(1)
    const [b] = await dono<{ qualificado: boolean | null; qualificado_em: Date | null }[]>`
      SELECT qualificado, qualificado_em FROM contato WHERE tenant_id = ${T} AND id = ${C_NOVO}`
    expect(b!.qualificado).toBeNull()
    expect(b!.qualificado_em).toBeNull()
  })

  it('estado inválido → 422; contato inexistente → 404', async () => {
    expect((await chamar(T, 'POST', `/v1/leads/${C_NOVO}/qualificar`, { estado: 'xpto' })).statusCode).toBe(422)
    expect((await chamar(T, 'POST', `/v1/leads/${randomUUID()}/qualificar`, { estado: 'qualificado' })).statusCode).toBe(404)
  })

  it('⚠️ isolamento: um tenant não vê nem qualifica lead do outro', async () => {
    await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES (${OUTRO}, ${randomUUID()}, 'De Outro', 'teste', true)`
    const c = await colunas(OUTRO)
    expect(total(c, 'novo')).toBe(1) // só o dele
    // OUTRO tentando qualificar contato de T → 404 (RLS esconde).
    expect((await chamar(OUTRO, 'POST', `/v1/leads/${C_NOVO}/qualificar`, { estado: 'descartado' })).statusCode).toBe(404)
  })
})
