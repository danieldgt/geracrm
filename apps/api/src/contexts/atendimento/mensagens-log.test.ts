import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'

/** Mensagens Enviadas — log das salientes (preview de texto, status, isolamento). */
const T = 'de10000a-0000-4000-8000-000000000001'
const OUTRO = 'de10000a-0000-4000-8000-000000000002'
const PV = 'de10000a-1111-4000-8000-000000000001'
const PV2 = 'de10000a-1111-4000-8000-000000000002'
const PLANO = 'de10000a-3333-4000-8000-000000000001'
const MODELO = 'de10000a-4444-4000-8000-000000000001'
const CANAL = 'de10000a-7777-4000-8000-000000000001'
const CONV = 'de10000a-8888-4000-8000-000000000001'
const C1 = 'de10000a-6666-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const chamar = (t: string, url: string) => app.inject({ method: 'GET', url, headers: { 'x-tenant-id': t } })

async function seedMsg(direcao: string, tipo: string, conteudo: object, status: string | null) {
  await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, status, status_ordem)
             VALUES (${T}, ${randomUUID()}, ${CONV}, ${direcao}, ${tipo}, ${JSON.stringify(conteudo)}::text::jsonb, ${status}, 0)`
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-ml', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-ml', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'A'], [OUTRO, PV2, 'B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES (${T}, ${C1}, 'Cliente Log', 'teste', true) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES (${T}, ${CANAL}, 'whatsapp_oficial', 'Zap', 'conectado') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id) VALUES (${T}, ${CONV}, ${CANAL}, ${C1}) ON CONFLICT DO NOTHING`
  await seedMsg('saliente', 'texto', { texto: 'Olá! Sua compra saiu.' }, 'enviada')
  await seedMsg('saliente', 'imagem', { imagem: 'chave-do-bucket' }, 'falhou')
  await seedMsg('entrante', 'texto', { texto: 'Recebido, obrigado' }, null) // entrante NÃO aparece
  app = await criarApp(); await app.ready()
})

afterAll(async () => {
  await dono`DELETE FROM mensagem WHERE tenant_id IN (${T}, ${OUTRO})`
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

describe('Mensagens Enviadas', () => {
  it('lista só as salientes, com preview de texto e rótulo de mídia', async () => {
    const r = (await chamar(T, '/v1/mensagens-enviadas')).json() as {
      itens: { tipo: string; preview: string; status: string | null; contato: string | null }[]
    }
    expect(r.itens.length).toBe(2) // a entrante ficou fora
    const texto = r.itens.find((i) => i.tipo === 'texto')
    const imagem = r.itens.find((i) => i.tipo === 'imagem')
    expect(texto).toMatchObject({ preview: 'Olá! Sua compra saiu.', status: 'enviada', contato: 'Cliente Log' })
    expect(imagem?.preview).toBe('[imagem]') // ⚠️ nunca o blob
  })

  it('filtra por status', async () => {
    const r = (await chamar(T, '/v1/mensagens-enviadas?status=falhou')).json() as { itens: { tipo: string }[] }
    expect(r.itens.length).toBe(1)
    expect(r.itens[0]!.tipo).toBe('imagem')
  })

  it('⚠️ isolamento: mensagens de um tenant não aparecem para outro (RLS)', async () => {
    const r = (await chamar(OUTRO, '/v1/mensagens-enviadas')).json() as { itens: unknown[] }
    expect(r.itens.length).toBe(0)
  })
})
