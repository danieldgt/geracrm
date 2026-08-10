import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco, comTenantServico } from '../../db/index.js'
import { parseWebhookPlugZapi } from './canais/plugzapi.js'
import { ingerirMensagemEntrante } from './ingestao-mensagem.js'

/**
 * O webhook de entrada — o nosso fluxo (INV-12/38), com payload REAL do PlugZapi.
 */
const T = 'a7e00000-0000-4000-8000-000000000001'
const PV = 'a7e00000-1111-4000-8000-000000000001'
const PLANO = 'a7e00000-3333-4000-8000-000000000001'
const MODELO = 'a7e00000-4444-4000-8000-000000000001'
const CANAL = 'a7e00000-5555-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance

const webhook = (corpo: unknown, canal = CANAL) =>
  app.inject({ method: 'POST', url: `/webhooks/plugzapi/${canal}`, payload: corpo as object })

// Payload REAL do PlugZapi (formato Z-API ReceivedCallback).
const recebida = (over: Record<string, unknown> = {}) => ({
  type: 'ReceivedCallback', instanceId: 'inst', messageId: 'MSG-1',
  phone: '5581998617049', fromMe: false, isGroup: false, momment: 1_700_000_000_000,
  senderName: 'Maria Cliente', text: { message: 'Oi, tem a camisa gola V?' }, ...over,
})

beforeAll(async () => {
  process.env.CREDENCIAL_CHAVE = 'chave-de-teste-com-mais-de-32-caracteres-aqui'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-wh', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-wh', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'Loja WH', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado)
             VALUES (${T}, ${CANAL}, 'whatsapp_nao_oficial', 'plugzapi', 'WhatsApp teste', 'conectado') ON CONFLICT DO NOTHING`
  app = await criarApp()
  await app.ready()
})

beforeEach(async () => {
  await dono`DELETE FROM outbox WHERE tenant_id = ${T}`
  await dono`DELETE FROM mensagem_id_externo WHERE tenant_id = ${T}`
  await dono`DELETE FROM mensagem WHERE tenant_id = ${T}`
  await dono`DELETE FROM conversa WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato_telefone WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato WHERE tenant_id = ${T}`
})

afterAll(async () => {
  await app.close(); await encerrarBanco()
  await dono`DELETE FROM outbox WHERE tenant_id = ${T}`
  await dono`DELETE FROM mensagem_id_externo WHERE tenant_id = ${T}`
  await dono`DELETE FROM mensagem WHERE tenant_id = ${T}`
  await dono`DELETE FROM conversa WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato_telefone WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato WHERE tenant_id = ${T}`
  await dono`DELETE FROM canal_conectado WHERE tenant_id = ${T}`
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${T}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${T}`
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await dono.end()
})

describe('parseWebhookPlugZapi', () => {
  it('mensagem entrante de texto vira evento', () => {
    const e = parseWebhookPlugZapi(recebida())
    expect(e.tipo).toBe('mensagem_entrante')
    if (e.tipo === 'mensagem_entrante') expect(e.mensagem).toMatchObject({ deE164: '5581998617049', texto: 'Oi, tem a camisa gola V?' })
  })
  it('⚠️ fromMe é ignorado (mensagem nossa, não do cliente)', () => {
    expect(parseWebhookPlugZapi(recebida({ fromMe: true })).tipo).toBe('ignorado')
  })
  it('⚠️ grupo é ignorado', () => {
    expect(parseWebhookPlugZapi(recebida({ isGroup: true })).tipo).toBe('ignorado')
  })
  it('status de entrega (outro type) é ignorado', () => {
    expect(parseWebhookPlugZapi({ type: 'MessageStatusCallback', status: 'READ' }).tipo).toBe('ignorado')
  })
})

describe('Webhook → Inbox (INV-12/38)', () => {
  it('⚠️ mensagem de número novo → contato-lead + conversa + mensagem na mesma transação', async () => {
    const r = await webhook(recebida())
    expect(r.statusCode).toBe(200)

    const [contato] = await dono`SELECT nome FROM contato WHERE tenant_id = ${T}`
    const [conv] = await dono`SELECT ultima_direcao FROM conversa WHERE tenant_id = ${T}`
    const [msg] = await dono`SELECT conteudo FROM mensagem WHERE tenant_id = ${T}`
    expect(contato!.nome).toBe('Maria Cliente')
    expect(conv!.ultima_direcao).toBe('entrante')
    expect((msg!.conteudo as { texto: string }).texto).toBe('Oi, tem a camisa gola V?')
  })

  it('⚠️ reentrega do MESMO messageId não duplica (INV-38)', async () => {
    await webhook(recebida())
    await webhook(recebida()) // PlugZapi reenvia
    const [lm] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM mensagem WHERE tenant_id = ${T}`
    expect(lm!.n).toBe(1)
  })

  it('⚠️ grava evento no OUTBOX no mesmo commit, com ids e SEM conteúdo (INV-40)', async () => {
    await webhook(recebida())
    const [ob] = await dono<{ tipo: string; agregado: string; payload: { conversaId?: string; versao?: number; texto?: string } }[]>`
      SELECT tipo, agregado, payload FROM outbox WHERE tenant_id = ${T} AND tipo = 'mensagem.recebida'`
    expect(ob!.tipo).toBe('mensagem.recebida')
    expect(ob!.agregado).toBe('conversa')
    expect(ob!.payload.conversaId).toBeTruthy()
    expect(ob!.payload.versao).toBeGreaterThan(0)
    // ⚠️ defesa em profundidade: o outbox NÃO carrega o texto da mensagem.
    expect(JSON.stringify(ob!.payload)).not.toContain('gola V')
  })

  it('⚠️ reentrega NÃO republica no outbox (um evento por mensagem)', async () => {
    await webhook(recebida())
    await webhook(recebida())
    const [lo] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM outbox WHERE tenant_id = ${T}`
    expect(lo!.n).toBe(1)
  })

  it('segunda mensagem do mesmo número entra na MESMA conversa', async () => {
    await webhook(recebida({ messageId: 'M1' }))
    await webhook(recebida({ messageId: 'M2', text: { message: 'e a azul?' } }))
    const [lc] = await dono<{ nc: number }[]>`SELECT count(*)::int AS nc FROM conversa WHERE tenant_id = ${T}`
    const [lmm] = await dono<{ nm: number }[]>`SELECT count(*)::int AS nm FROM mensagem WHERE tenant_id = ${T}`
    expect([lc!.nc, lmm!.nm]).toEqual([1, 2])
  })

  it('evento ignorado (grupo) responde 200 sem criar nada', async () => {
    const r = await webhook(recebida({ isGroup: true }))
    expect(r.statusCode).toBe(200)
    const [lg] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM conversa WHERE tenant_id = ${T}`
    expect(lg!.n).toBe(0)
  })

  it('canal inexistente → 404 (URL errada, não evento a ignorar)', async () => {
    const r = await webhook(recebida(), 'a7e00000-9999-4000-8000-000000000009')
    expect(r.statusCode).toBe(404)
  })
})

// E5-14: a ingestão SINALIZA a mídia de entrada a copiar (a cópia em si é
// pós-commit e best-effort). Aqui fixamos QUANDO ela é sinalizada.
describe('Mídia de entrada a copiar (E5-14)', () => {
  const ingerir = (msg: Parameters<typeof ingerirMensagemEntrante>[2]) =>
    comTenantServico(T, (tx) => ingerirMensagemEntrante(tx, CANAL, msg))

  it('⚠️ imagem com URL do provedor sinaliza midiaExterna (id + tipo + url + mime)', async () => {
    const r = await ingerir({
      idExterno: 'IMG-1', deE164: '5581998617049', tipo: 'imagem',
      midiaUrl: 'https://storage.plugzapi/xyz.jpg', mime: 'image/jpeg',
      recebidaEm: new Date(1_700_000_100_000), nomeRemetente: 'Maria',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.midiaExterna).toBeDefined()
      expect(r.midiaExterna).toMatchObject({ tipo: 'imagem', url: 'https://storage.plugzapi/xyz.jpg', mime: 'image/jpeg' })
      expect(r.midiaExterna!.mensagemId).toBeTruthy()
    }
  })

  it('texto NÃO sinaliza mídia a copiar', async () => {
    const r = await ingerir({
      idExterno: 'TXT-1', deE164: '5581998617049', tipo: 'texto',
      texto: 'sem mídia', recebidaEm: new Date(1_700_000_200_000), nomeRemetente: 'Maria',
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.midiaExterna).toBeUndefined()
  })

  it('reentrega (duplicada) não sinaliza nova cópia', async () => {
    const msg = {
      idExterno: 'IMG-DUP', deE164: '5581998617049', tipo: 'imagem' as const,
      midiaUrl: 'https://storage.plugzapi/dup.jpg', mime: 'image/jpeg',
      recebidaEm: new Date(1_700_000_300_000), nomeRemetente: 'Maria',
    }
    await ingerir(msg)
    const r2 = await ingerir(msg) // PlugZapi reenvia
    expect(r2.ok).toBe(true)
    if (r2.ok) { expect(r2.duplicada).toBe(true); expect(r2.midiaExterna).toBeUndefined() }
  })
})
