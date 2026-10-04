import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import type { FastifyInstance } from 'fastify'
import { criarApp } from '../../../app.js'
import { encerrarBanco, comTenantServico } from '../../../db/index.js'
import { criarLlmDoCatalogo, chaveQueFalta } from './fabrica-ferramentas.js'
import { resolverModelo } from './modelos.js'

/**
 * O catálogo de modelos (0093): o que o tenant vê, o que o staff libera, e o
 * que a tela do agente aceita — docs/estudo-modelos-llm.md §3.
 */
const T = 'b6a60000-0000-4000-8000-000000000001'
const OUTRO = 'b6a60000-0000-4000-8000-000000000002'
const PV = 'b6a60000-1111-4000-8000-000000000001'
const PV2 = 'b6a60000-1111-4000-8000-000000000002'
const PLANO = 'b6a60000-3333-4000-8000-000000000001'
const MODELO = 'b6a60000-4444-4000-8000-000000000001'
const CANAL = 'b6a60000-7777-4000-8000-000000000001'
const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
// Staff em dev = DEV_STAFF=on (lido a cada requisição pelo plugin de tenant).
const chamar = async (t: string, m: 'GET' | 'PUT', url: string, corpo?: Record<string, unknown>, staff = false) => {
  if (staff) process.env.DEV_STAFF = 'on'; else delete process.env.DEV_STAFF
  try {
    return await app.inject({ method: m, url, headers: { 'x-tenant-id': t }, ...(corpo ? { payload: corpo } : {}) })
  } finally { delete process.env.DEV_STAFF }
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  process.env.IA_PROVEDOR = 'simulado'
  delete process.env.GROQ_API_KEY
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-modelos-ia', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-modelos-ia', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'A'], [OUTRO, PV2, 'B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES (${T}, ${CANAL}, 'whatsapp_nao_oficial', 'Loja', 'conectado') ON CONFLICT DO NOTHING`
  app = await criarApp(); await app.ready()
})
afterAll(async () => {
  for (const t of ['agente_config', 'tenant_modelo_ia', 'canal_conectado']) for (const ten of [T, OUTRO]) await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id = '${ten}'`)
  await dono`DELETE FROM tenant WHERE id IN (${T}, ${OUTRO})`
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('O que o tenant vê', () => {
  it('sem regra, vê os padrões do catálogo, com disponibilidade pelo servidor', async () => {
    const r = (await chamar(T, 'GET', '/v1/agente/modelos')).json() as { itens: { codigo: string; padrao: boolean; disponivel: boolean; motivoIndisponivel: string | null }[] }
    expect(r.itens.length).toBeGreaterThan(0)
    expect(r.itens.every((i) => i.padrao)).toBe(true)
    const groq = r.itens.find((i) => i.codigo === 'groq-llama-3-3-70b')!
    expect(groq.disponivel).toBe(false)
    expect(groq.motivoIndisponivel).toContain('GROQ_API_KEY')
  })
})

describe('Staff libera por cliente', () => {
  it('restringe a lista; o cliente passa a ver só o liberado; outro tenant não muda', async () => {
    const put = await chamar(T, 'PUT', `/v1/plataforma/clientes/${T}/modelos`, { codigos: ['groq-gpt-oss-120b', 'openrouter-free'] }, true)
    expect(put.statusCode, put.body).toBe(200)
    const r = (await chamar(T, 'GET', '/v1/agente/modelos')).json() as { itens: { codigo: string }[] }
    expect(r.itens.map((i) => i.codigo).sort()).toEqual(['groq-gpt-oss-120b', 'openrouter-free'])
    const outro = (await chamar(OUTRO, 'GET', '/v1/agente/modelos')).json() as { itens: { codigo: string }[] }
    expect(outro.itens.length).toBeGreaterThan(2)
    const cat = (await chamar(T, 'GET', `/v1/plataforma/clientes/${T}/modelos`, undefined, true)).json() as { itens: { codigo: string; permitido: boolean }[] }
    expect(cat.itens.find((i) => i.codigo === 'claude-opus-5-5')!.permitido).toBe(false)
    expect(cat.itens.find((i) => i.codigo === 'openrouter-free')!.permitido).toBe(true)
  })
  it('código fora do catálogo → 422; lista vazia volta aos padrões; sem staff → recusado', async () => {
    expect((await chamar(T, 'PUT', `/v1/plataforma/clientes/${T}/modelos`, { codigos: ['nao-existe'] }, true)).statusCode).toBe(422)
    expect((await chamar(T, 'PUT', `/v1/plataforma/clientes/${T}/modelos`, { codigos: [] }, true)).statusCode).toBe(200)
    const r = (await chamar(T, 'GET', '/v1/agente/modelos')).json() as { itens: unknown[] }
    expect(r.itens.length).toBeGreaterThan(2)
    expect((await chamar(T, 'PUT', `/v1/plataforma/clientes/${T}/modelos`, { codigos: [] })).statusCode).toBeGreaterThanOrEqual(401)
  })
})

describe('A tela do agente só aceita modelo permitido e disponível', () => {
  it('não permitido → 422; permitido sem chave → 422 com o nome da variável; com chave → grava o código', async () => {
    await chamar(T, 'PUT', `/v1/plataforma/clientes/${T}/modelos`, { codigos: ['groq-llama-3-3-70b'] }, true)
    const np = await chamar(T, 'PUT', `/v1/canais/${CANAL}/agente`, { modo: 'sombra', modelo: 'claude-opus-5-5' })
    expect(np.statusCode).toBe(422)
    expect((np.json() as { erro: string }).erro).toBe('agente.modelo_nao_permitido')
    const semChave = await chamar(T, 'PUT', `/v1/canais/${CANAL}/agente`, { modo: 'sombra', modelo: 'groq-llama-3-3-70b' })
    expect(semChave.statusCode).toBe(422)
    expect((semChave.json() as { erro: string; mensagem: string }).mensagem).toContain('GROQ_API_KEY')
    process.env.GROQ_API_KEY = 'chave-de-teste'
    try {
      const ok = await chamar(T, 'PUT', `/v1/canais/${CANAL}/agente`, { modo: 'sombra', modelo: 'groq-llama-3-3-70b' })
      expect(ok.statusCode, ok.body).toBe(200)
      const g = (await chamar(T, 'GET', `/v1/canais/${CANAL}/agente`)).json() as { modelo: string }
      expect(g.modelo).toBe('groq-llama-3-3-70b')
      // O turno resolve o código para {provedor, modelo} e monta o adaptador do Groq.
      const resolvido = await comTenantServico(T, (tx) => resolverModelo(tx, 'groq-llama-3-3-70b'))
      expect(resolvido).toMatchObject({ provedor: 'groq', modelo: 'llama-3.3-70b-versatile' })
      expect(criarLlmDoCatalogo(resolvido!).nome).toBe('groq')
    } finally {
      delete process.env.GROQ_API_KEY
    }
    // Código não permitido no turno → null (cai no padrão do ambiente), nunca um modelo de outro cliente.
    expect(await comTenantServico(T, (tx) => resolverModelo(tx, 'claude-opus-5-5'))).toBeNull()
    await chamar(T, 'PUT', `/v1/plataforma/clientes/${T}/modelos`, { codigos: [] }, true)
  })
  it('chaveQueFalta nomeia a variável de cada fornecedor', () => {
    expect(chaveQueFalta('claude', {})).toBe('ANTHROPIC_API_KEY')
    expect(chaveQueFalta('maritaca', {})).toBe('MARITACA_API_KEY')
    expect(chaveQueFalta('cerebras', { CEREBRAS_API_KEY: 'k' })).toBeNull()
  })
})
