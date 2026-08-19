import { createHmac } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'
import { parseWebhookMeta, verificarAssinaturaMeta } from './canais/meta.js'

/** Webhook da Meta: handshake de verify, assinatura HMAC e parsing por contrato.
 *  ⚠️ Meta SEMPRE mockada — fixtures reais, nunca a Graph API (skill). */
const TOKEN = 'verify-token-de-teste'
const SEGREDO = 'app-secret-de-teste'

let app: FastifyInstance
const assinar = (corpo: string) => 'sha256=' + createHmac('sha256', SEGREDO).update(Buffer.from(corpo)).digest('hex')
const postar = (corpo: string, sig?: string) =>
  app.inject({ method: 'POST', url: '/webhooks/meta',
    headers: { 'content-type': 'application/json', ...(sig ? { 'x-hub-signature-256': sig } : {}) }, payload: corpo })

// Fixture real (encurtada) de mensagem entrante do WhatsApp Cloud API.
const MSG = {
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA123', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '5581999990000', phone_number_id: 'PHONE99' },
    contacts: [{ profile: { name: 'Maria' }, wa_id: '5581988887777' }],
    messages: [{ from: '5581988887777', id: 'wamid.ABC', timestamp: '1690000000', type: 'text', text: { body: 'oi, tem reposição?' } }],
  } }] }],
}
const STATUS = {
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA123', changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: 'PHONE99' },
    statuses: [{ id: 'wamid.XYZ', status: 'delivered', timestamp: '1690000100', recipient_id: '5581988887777' }],
  } }] }],
}
const TEMPLATE = {
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA123', changes: [{ field: 'message_template_status_update', value: {
    message_template_name: 'reposicao_mensal', message_template_language: 'pt_BR', event: 'APPROVED',
  } }] }],
}

beforeAll(async () => {
  process.env.META_VERIFY_TOKEN = TOKEN
  process.env.META_APP_SECRET = SEGREDO
  app = await criarApp(); await app.ready()
})
afterAll(async () => { await app.close(); await encerrarBanco() })

describe('Webhook da Meta', () => {
  it('GET verify: token certo devolve o challenge; token errado → 403', async () => {
    const ok = await app.inject({ method: 'GET', url: `/webhooks/meta?hub.mode=subscribe&hub.verify_token=${TOKEN}&hub.challenge=42abc` })
    expect(ok.statusCode).toBe(200)
    expect(ok.body).toBe('42abc')
    const nao = await app.inject({ method: 'GET', url: `/webhooks/meta?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=42abc` })
    expect(nao.statusCode).toBe(403)
  })

  it('POST: sem assinatura ou com assinatura errada → 401', async () => {
    const corpo = JSON.stringify(MSG)
    expect((await postar(corpo)).statusCode).toBe(401) // sem header
    expect((await postar(corpo, 'sha256=deadbeef')).statusCode).toBe(401) // errada
  })

  it('POST: assinatura válida → 200 e reconhece os eventos', async () => {
    const corpo = JSON.stringify(MSG)
    const r = await postar(corpo, assinar(corpo))
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ ok: true, eventos: 1 })
  })

  it('POST: sem META_APP_SECRET → 401 (não dá para verificar autenticidade)', async () => {
    const salvo = process.env.META_APP_SECRET
    delete process.env.META_APP_SECRET
    const corpo = JSON.stringify(MSG)
    expect((await postar(corpo, assinar(corpo))).statusCode).toBe(401)
    process.env.META_APP_SECRET = salvo
  })

  it('parseWebhookMeta: mensagem, status e template', () => {
    const [m] = parseWebhookMeta(MSG)
    expect(m).toMatchObject({ tipo: 'mensagem', phoneNumberId: 'PHONE99', de: '5581988887777', idExterno: 'wamid.ABC', nomePerfil: 'Maria' })
    expect(m!.tipo === 'mensagem' && m!.conteudo).toMatchObject({ tipo: 'texto', texto: 'oi, tem reposição?' })

    const [s] = parseWebhookMeta(STATUS)
    expect(s).toMatchObject({ tipo: 'status', idExterno: 'wamid.XYZ', status: 'entregue' }) // 'delivered' → 'entregue'

    const [t] = parseWebhookMeta(TEMPLATE)
    expect(t).toMatchObject({ tipo: 'template_status', nome: 'reposicao_mensal', idioma: 'pt_BR', status: 'APPROVED' })

    expect(parseWebhookMeta({ foo: 1 })).toEqual([{ tipo: 'ignorado', motivo: 'sem_entry' }])
  })

  it('verificarAssinaturaMeta: aceita a correta, rejeita adulteração', () => {
    const corpo = Buffer.from(JSON.stringify(MSG))
    const boa = assinar(corpo.toString())
    expect(verificarAssinaturaMeta(corpo, boa, SEGREDO)).toBe(true)
    expect(verificarAssinaturaMeta(Buffer.from(corpo.toString() + ' '), boa, SEGREDO)).toBe(false)
    expect(verificarAssinaturaMeta(corpo, undefined, SEGREDO)).toBe(false)
  })
})
