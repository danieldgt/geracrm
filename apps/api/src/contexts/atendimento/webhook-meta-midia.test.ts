import { createHmac } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'

/**
 * Webhook da Meta → INGESTÃO DE MÍDIA (R5): imagem e áudio entram com o
 * placeholder `meta:media:<id>` (download é outro passo, fora do 200), botão
 * respondido vira texto, status de entrega continua funcionando, e tipo não
 * suportado responde 200 sem criar nada.
 */
const T = 'e8000000-0000-4000-8000-000000000001'
const PV = 'e8000000-1111-4000-8000-000000000001'
const PLANO = 'e8000000-3333-4000-8000-000000000001'
const MODELO = 'e8000000-4444-4000-8000-000000000001'
const CANAL = 'e8000000-7777-4000-8000-000000000001'
const CONTATO = 'e8000000-6666-4000-8000-000000000001'
const CONVERSA = 'e8000000-8888-4000-8000-000000000001'
const PHONE = 'PHONE-MIDIA-R5'
const SEGREDO = 'app-secret-midia-r5'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const assinar = (c: string) => 'sha256=' + createHmac('sha256', SEGREDO).update(Buffer.from(c)).digest('hex')
const postar = (corpo: string) => app.inject({
  method: 'POST', url: '/webhooks/meta',
  headers: { 'content-type': 'application/json', 'x-hub-signature-256': assinar(corpo) }, payload: corpo,
})
const envelope = (value: Record<string, unknown>) => JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA-R5', changes: [{ field: 'messages', value: { metadata: { phone_number_id: PHONE }, ...value } }] }],
})
const mensagem = (m: Record<string, unknown>, id = 'wamid.MID1') => envelope({
  contacts: [{ profile: { name: 'Cliente Mídia' }, wa_id: '5581977776666' }],
  messages: [{ from: '5581977776666', id, timestamp: '1690000000', ...m }],
})
const mensagens = () => dono<{ tipo: string; conteudo: Record<string, unknown>; id_externo: string | null }[]>`
  SELECT tipo, conteudo, id_externo FROM mensagem WHERE tenant_id = ${T} AND direcao = 'entrante' ORDER BY criado_em`

beforeAll(async () => {
  process.env.META_VERIFY_TOKEN = 'tok'
  process.env.META_APP_SECRET = SEGREDO
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-midia-r5', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-midia-r5', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'Mídia R5', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado, identificador_externo)
             VALUES (${T}, ${CANAL}, 'whatsapp_oficial', 'meta_oficial', 'Oficial', 'conectado', ${PHONE}) ON CONFLICT DO NOTHING`
  app = await criarApp(); await app.ready()
})

beforeEach(async () => {
  await dono`DELETE FROM mensagem WHERE tenant_id = ${T}`
  await dono`DELETE FROM conversa WHERE tenant_id = ${T}`
  await dono`DELETE FROM mensagem_id_externo WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato_telefone WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato WHERE tenant_id = ${T}`
})

afterAll(async () => {
  for (const t of ['mensagem', 'conversa', 'mensagem_id_externo', 'contato_telefone', 'contato', 'canal_conectado', 'outbox']) {
    await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id = '${T}'`)
  }
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${T}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${T}`
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('Webhook Meta — mídia e botões', () => {
  it('imagem entra como mensagem de imagem com o media id como placeholder, mime e legenda', async () => {
    const r = await postar(mensagem({ type: 'image', image: { id: '1111222233334444', mime_type: 'image/jpeg', sha256: 'x', caption: 'essa aqui' } }))
    expect(r.statusCode).toBe(200)
    const [m] = await mensagens()
    expect(m).toBeTruthy()
    expect(m!.tipo).toBe('imagem')
    expect(m!.conteudo).toMatchObject({ imagem: 'meta:media:1111222233334444', mime: 'image/jpeg', legenda: 'essa aqui' })
  })

  it('áudio entra como mensagem de áudio sem transcrição (quem transcreve é o worker)', async () => {
    const r = await postar(mensagem({ type: 'audio', audio: { id: '5555666677778888', mime_type: 'audio/ogg; codecs=opus', voice: true } }, 'wamid.AUD1'))
    expect(r.statusCode).toBe(200)
    const [m] = await mensagens()
    expect(m!.tipo).toBe('audio')
    expect(m!.conteudo).toMatchObject({ audio: 'meta:media:5555666677778888', mime: 'audio/ogg; codecs=opus' })
    expect(m!.conteudo['transcricao']).toBeUndefined()
  })

  it('reentrega do MESMO áudio não duplica', async () => {
    const corpo = mensagem({ type: 'audio', audio: { id: '1', mime_type: 'audio/ogg' } }, 'wamid.AUD-DUP')
    await postar(corpo); await postar(corpo)
    expect(await mensagens()).toHaveLength(1)
  })

  it('resposta de botão chega como texto — é o "sim" que o domínio interpreta', async () => {
    const r = await postar(mensagem({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'confirmar', title: 'Confirmar' } } }, 'wamid.BTN1'))
    expect(r.statusCode).toBe(200)
    const [m] = await mensagens()
    expect(m!.tipo).toBe('texto')
    expect(m!.conteudo).toMatchObject({ texto: 'Confirmar' })
  })

  it('tipo ainda não ingerido (vídeo) responde 200 sem criar conversa', async () => {
    const r = await postar(mensagem({ type: 'video', video: { id: '9', mime_type: 'video/mp4' } }, 'wamid.VID1'))
    expect(r.statusCode).toBe(200)
    const [n] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM conversa WHERE tenant_id = ${T}`
    expect(n!.n).toBe(0)
  })

  it('status de entrega continua avançando os tiques de uma mensagem NOSSA', async () => {
    await dono`INSERT INTO contato (tenant_id, id, nome, ativo) VALUES (${T}, ${CONTATO}, 'C', true)`
    await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${T}, ${CONVERSA}, ${CANAL}, ${CONTATO}, 1)`
    await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, status, status_ordem, id_externo)
               VALUES (${T}, ${'e8000000-9999-4000-8000-000000000001'}, ${CONVERSA}, 'saliente', 'texto', '{"texto":"oi"}'::jsonb, 'enviada', 1, 'wamid.OUT-R5')`
    const r = await postar(envelope({ statuses: [{ id: 'wamid.OUT-R5', status: 'read', timestamp: '1690000100', recipient_id: '5581977776666' }] }))
    expect(r.statusCode).toBe(200)
    const [m] = await dono<{ status: string }[]>`SELECT status FROM mensagem WHERE tenant_id = ${T} AND id_externo = 'wamid.OUT-R5'`
    expect(m!.status).toBe('lida')
  })
})
