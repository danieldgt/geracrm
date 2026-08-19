import { createHmac } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'

/** Webhook da Meta → INGESTÃO: roteia por phone_number_id, acende o Inbox,
 *  é idempotente, e canal desconhecido responde 200 (falha permanente). */
const T = 'e7000000-0000-4000-8000-000000000001'
const PV = 'e7000000-1111-4000-8000-000000000001'
const PLANO = 'e7000000-3333-4000-8000-000000000001'
const MODELO = 'e7000000-4444-4000-8000-000000000001'
const CANAL = 'e7000000-7777-4000-8000-000000000001'
const PHONE = 'PHONE-INGEST-99'
const SEGREDO = 'app-secret-ingestao'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const assinar = (c: string) => 'sha256=' + createHmac('sha256', SEGREDO).update(Buffer.from(c)).digest('hex')
const postar = (corpo: string) => app.inject({
  method: 'POST', url: '/webhooks/meta',
  headers: { 'content-type': 'application/json', 'x-hub-signature-256': assinar(corpo) }, payload: corpo,
})
const msg = (texto: string, id = 'wamid.ING1', phone = PHONE) => JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA1', changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: phone },
    contacts: [{ profile: { name: 'Cliente Meta' }, wa_id: '5581988887777' }],
    messages: [{ from: '5581988887777', id, timestamp: '1690000000', type: 'text', text: { body: texto } }],
  } }] }],
})

beforeAll(async () => {
  process.env.META_VERIFY_TOKEN = 'tok'
  process.env.META_APP_SECRET = SEGREDO
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-mi', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-mi', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'MI', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  // Canal Meta com o identificador de roteamento em claro.
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado, identificador_externo)
             VALUES (${T}, ${CANAL}, 'whatsapp_oficial', 'meta_oficial', 'Oficial', 'conectado', ${PHONE}) ON CONFLICT DO NOTHING`
  app = await criarApp(); await app.ready()
})

beforeEach(async () => {
  await dono`DELETE FROM mensagem WHERE tenant_id = ${T}`
  await dono`DELETE FROM conversa WHERE tenant_id = ${T}`
  await dono`DELETE FROM mensagem_id_externo WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato_telefone WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato WHERE tenant_id = ${T} AND origem_carga = 'whatsapp'`
})

afterAll(async () => {
  await dono`DELETE FROM mensagem WHERE tenant_id = ${T}`
  await dono`DELETE FROM conversa WHERE tenant_id = ${T}`
  await dono`DELETE FROM mensagem_id_externo WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato_telefone WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato WHERE tenant_id = ${T}`
  await dono`DELETE FROM canal_conectado WHERE tenant_id = ${T}`
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${T}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${T}`
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('Webhook Meta — ingestão', () => {
  it('mensagem entrante acende o Inbox: cria lead, conversa e mensagem', async () => {
    const r = await postar(msg('tem reposição?'))
    expect(r.statusCode).toBe(200)
    const [conv] = await dono<{ id: string; contato_id: string }[]>`SELECT id, contato_id FROM conversa WHERE tenant_id = ${T}`
    expect(conv).toBeTruthy()
    const [m] = await dono<{ conteudo: { texto: string }; direcao: string }[]>`
      SELECT conteudo, direcao FROM mensagem WHERE tenant_id = ${T}`
    expect(m!.direcao).toBe('entrante')
    expect(m!.conteudo.texto).toBe('tem reposição?')
    const [c] = await dono<{ nome: string }[]>`SELECT nome FROM contato WHERE tenant_id = ${T} AND id = ${conv!.contato_id}`
    expect(c!.nome).toBe('Cliente Meta')
  })

  it('idempotente: reentrega da MESMA mensagem não duplica', async () => {
    await postar(msg('oi', 'wamid.DEDUP'))
    await postar(msg('oi', 'wamid.DEDUP'))
    const [linha] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM mensagem WHERE tenant_id = ${T}`
    expect(linha!.n).toBe(1)
  })

  it('phone_number_id desconhecido → 200 sem criar nada (falha permanente)', async () => {
    const r = await postar(msg('oi', 'wamid.X', 'PHONE-INEXISTENTE'))
    expect(r.statusCode).toBe(200)
    const [linha] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM conversa WHERE tenant_id = ${T}`
    expect(linha!.n).toBe(0)
  })
})
