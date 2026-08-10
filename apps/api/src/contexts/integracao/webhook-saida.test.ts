import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import postgres from 'postgres'
import { createHmac } from 'node:crypto'
import { assinar, backoffSegundos, entregarLote, despacharTodos, type Webhook, type FetchFn } from './webhook-saida.js'

/**
 * INT-07 — despachante de webhooks de saída. Fixa: assinatura HMAC, avanço de
 * cursor no sucesso, filtro por tipo de evento, retry com backoff na falha e
 * dead-letter depois do teto. A rede entra por um fetch falso (sem sair).
 */
describe('assinar / backoff (puros)', () => {
  it('assina com HMAC-SHA256 do corpo', () => {
    const corpo = '{"a":1}'
    expect(assinar(corpo, 'segredo')).toBe(createHmac('sha256', 'segredo').update(corpo).digest('hex'))
  })
  it('backoff cresce e tem teto de 1h', () => {
    expect(backoffSegundos(1)).toBe(30)
    expect(backoffSegundos(2)).toBe(60)
    expect(backoffSegundos(3)).toBe(120)
    expect(backoffSegundos(20)).toBe(3600)
  })
})

const T = 'e07f0000-0000-4000-8000-000000000001'
const PV = 'e07f0000-1111-4000-8000-000000000001'
const PLANO = 'e07f0000-3333-4000-8000-000000000001'
const MODELO = 'e07f0000-4444-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const AGORA = new Date('2026-08-09T12:00:00Z')

const wh = (over: Partial<Webhook> = {}): Webhook => ({
  tenant_id: T, id: 'e07f0000-9999-4000-8000-000000000001', url: 'https://ex/hook',
  eventos: [], segredo: 'sec', cursor: '0', ...over,
})

const okFetch: FetchFn = async () => ({ ok: true, status: 200 })
const falhaFetch: FetchFn = async () => ({ ok: false, status: 500 })

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-wsaida', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-wsaida', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'Loja W', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
})

beforeEach(async () => { await dono`DELETE FROM outbox WHERE tenant_id = ${T}` })

afterAll(async () => {
  await dono`DELETE FROM outbox WHERE tenant_id = ${T}`
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${T}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${T}`
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await dono.end()
})

/** Semeia N eventos e devolve os ids em ordem. */
async function semear(tipos: string[]): Promise<string[]> {
  const ids: string[] = []
  for (const tipo of tipos) {
    const [r] = await dono<{ id: string }[]>`
      INSERT INTO outbox (tenant_id, tipo, agregado, payload)
      VALUES (${T}, ${tipo}, 'conversa', '{}'::jsonb) RETURNING id::text`
    ids.push(r!.id)
  }
  return ids
}

describe('entregarLote', () => {
  it('entrega todos e avança o cursor até o último id', async () => {
    const ids = await semear(['a', 'b', 'c'])
    const fetchSpy = vi.fn(okFetch)
    const r = await entregarLote(dono as never, fetchSpy, wh(), 0, AGORA)
    expect(fetchSpy).toHaveBeenCalledTimes(3)
    expect(r.cursor).toBe(ids[2])
    expect(r.entregou).toBe(true)
    expect(r.proximaEm).toBeNull()
  })

  it('⚠️ envia assinatura e headers de idempotência', async () => {
    await semear(['x'])
    const fetchSpy = vi.fn(okFetch)
    await entregarLote(dono as never, fetchSpy, wh({ segredo: 'top' }), 0, AGORA)
    const [, init] = fetchSpy.mock.calls[0]!
    expect(init.headers['x-geracrm-signature']).toBe(`sha256=${assinar(init.body, 'top')}`)
    expect(init.headers['x-geracrm-delivery']).toBeTruthy()
    expect(init.headers['x-geracrm-event']).toBe('x')
  })

  it('filtra por tipo: entrega só os inscritos, mas avança o cursor pelos demais', async () => {
    const ids = await semear(['ignora', 'quero', 'ignora'])
    const fetchSpy = vi.fn(okFetch)
    const r = await entregarLote(dono as never, fetchSpy, wh({ eventos: ['quero'] }), 0, AGORA)
    expect(fetchSpy).toHaveBeenCalledTimes(1) // só 'quero'
    expect(r.cursor).toBe(ids[2]) // cursor no fim mesmo assim
  })

  it('⚠️ falha NÃO avança o cursor e agenda retry com backoff', async () => {
    await semear(['a', 'b'])
    const r = await entregarLote(dono as never, falhaFetch, wh(), 0, AGORA)
    expect(r.cursor).toBe('0') // parou no primeiro, não avançou
    expect(r.tentativas).toBe(1)
    expect(r.proximaEm).toEqual(new Date(AGORA.getTime() + 30_000))
    expect(r.ultimoErro).toContain('falha')
  })

  it('⚠️ dead-letter após o teto: pula o evento e destrava a fila', async () => {
    const ids = await semear(['a', 'b'])
    // Já com 7 tentativas; a 8ª estoura o MAX (8) → dead-letter.
    const r = await entregarLote(dono as never, falhaFetch, wh(), 7, AGORA)
    expect(r.cursor).toBe(ids[0]) // pulou o evento problemático
    expect(r.tentativas).toBe(0)
    expect(r.ultimoErro).toContain('dead-letter')
  })
})

describe('despacharTodos: passada completa com advisory lock', () => {
  const WID = 'e07f0000-a000-4000-8000-000000000001'
  it('entrega os eventos dos webhooks ativos e persiste cursor + entregue_em', async () => {
    await dono`DELETE FROM webhook_saida WHERE tenant_id = ${T}`
    await dono`DELETE FROM outbox WHERE tenant_id = ${T}`
    const ids = await semear(['a', 'b'])
    await dono`INSERT INTO webhook_saida (tenant_id, id, url, eventos, segredo, cursor)
               VALUES (${T}, ${WID}, 'https://ex/h', '{}', 'sec', 0)`

    const n = await despacharTodos(dono as never, okFetch, AGORA)
    expect(n).toBeGreaterThanOrEqual(1)
    const [w] = await dono<{ cursor: string; entregue_em: Date | null }[]>`
      SELECT cursor::text, entregue_em FROM webhook_saida WHERE tenant_id = ${T} AND id = ${WID}`
    expect(w!.cursor).toBe(ids[1])
    expect(w!.entregue_em).not.toBeNull()
    await dono`DELETE FROM webhook_saida WHERE tenant_id = ${T}`
  })
})
