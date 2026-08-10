import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'

/**
 * Onda 3 — Campanhas com ROI. Fixa: ROI separa atribuição EXATA (pedido nascido
 * da campanha) da ESTIMADA (comprou na janela) — nunca somadas; a janela é
 * respeitada; disparar é idempotente e computa a audiência por segmento (matview).
 */
const T = 'ca3f0000-0000-4000-8000-000000000001'
const OUTRO = 'ca3f0000-0000-4000-8000-000000000002'
const PV = 'ca3f0000-1111-4000-8000-000000000001'
const PV2 = 'ca3f0000-1111-4000-8000-000000000002'
const PLANO = 'ca3f0000-3333-4000-8000-000000000001'
const MODELO = 'ca3f0000-4444-4000-8000-000000000001'
const CONTATO = 'ca3f0000-6666-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const chamar = (t: string, m: 'GET' | 'POST', url: string, corpo?: Record<string, unknown>) =>
  app.inject({ method: m, url, headers: { 'x-tenant-id': t }, ...(corpo ? { payload: corpo } : {}) })

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-camp', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-camp', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'A'], [OUTRO, PV2, 'B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES (${T}, ${CONTATO}, 'Cliente', 'teste', true) ON CONFLICT DO NOTHING`
  app = await criarApp(); await app.ready()
})

beforeEach(async () => {
  await dono`DELETE FROM campanha_envio WHERE tenant_id = ${T}`
  await dono`DELETE FROM campanha WHERE tenant_id = ${T}`
  await dono`DELETE FROM pedido WHERE tenant_id = ${T}`
  await dono`DELETE FROM venda WHERE tenant_id = ${T}`
})

afterAll(async () => {
  await dono`DELETE FROM campanha_envio WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM campanha WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM pedido WHERE tenant_id = ${T}`
  await dono`DELETE FROM venda WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato WHERE tenant_id = ${T}`
  for (const t of [T, OUTRO]) {
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

const criarCampanha = async (t: string, segmento = 'todos') => {
  const r = await chamar(t, 'POST', '/v1/campanhas', { nome: 'Volta!', mensagem: 'Oi, temos novidade', segmentoAlvo: segmento, janelaDias: 7 })
  return (r.json() as { id: string }).id
}

describe('Onda 3: Campanhas com ROI', () => {
  it('cria e lista campanha', async () => {
    await criarCampanha(T)
    const l = await chamar(T, 'GET', '/v1/campanhas')
    expect((l.json() as { itens: unknown[] }).itens.length).toBe(1)
  })

  it('⚠️ ROI separa exata (pedido da campanha) de estimada (venda na janela)', async () => {
    const id = await criarCampanha(T)
    // Disparada há 3 dias, janela 7 → conta vendas em [-3d, +4d].
    await dono`UPDATE campanha SET estado='disparando', disparada_em = now() - interval '3 days' WHERE tenant_id=${T} AND id=${id}`
    await dono`INSERT INTO campanha_envio (tenant_id, id, campanha_id, contato_id, estado, enviado_em)
               VALUES (${T}, ${randomUUID()}, ${id}, ${CONTATO}, 'enviado', now() - interval '3 days')`
    // EXATA: pedido efetivado vinculado à campanha.
    await dono`INSERT INTO pedido (tenant_id, id, contato_id, estado, total_centavos, campanha_id, numero_externo)
               VALUES (${T}, ${randomUUID()}, ${CONTATO}, 'efetivado', 30000, ${id}, 'NF-1')`
    // ESTIMADA: venda no ERP DENTRO da janela (há 1 dia).
    await dono`INSERT INTO venda (tenant_id, id, contato_id, ocorrida_em, valor_centavos)
               VALUES (${T}, ${randomUUID()}, ${CONTATO}, now() - interval '1 day', 50000)`
    // FORA da janela (há 40 dias, antes do disparo) — não conta.
    await dono`INSERT INTO venda (tenant_id, id, contato_id, ocorrida_em, valor_centavos)
               VALUES (${T}, ${randomUUID()}, ${CONTATO}, now() - interval '40 days', 99999)`

    const roi = (await chamar(T, 'GET', `/v1/campanhas/${id}/roi`).then((r) => r.json())) as {
      exata: { pedidos: number; receitaCentavos: number }
      estimada: { vendas: number; receitaCentavos: number }
      janelaDias: number
    }
    expect(roi.exata).toEqual({ pedidos: 1, receitaCentavos: 30000 })
    expect(roi.estimada).toEqual({ vendas: 1, receitaCentavos: 50000 }) // só a de dentro da janela
    expect(roi.janelaDias).toBe(7)
  })

  it('audiência por segmento + disparar idempotente (409 na 2ª vez)', async () => {
    // Uma venda antiga p/ o contato ter métrica; refresh da matview.
    await dono`INSERT INTO venda (tenant_id, id, contato_id, ocorrida_em, valor_centavos)
               VALUES (${T}, ${randomUUID()}, ${CONTATO}, now() - interval '10 days', 20000)`
    await dono`SELECT atualizar_metricas_contato()`
    const id = await criarCampanha(T, 'todos')
    const aud = await chamar(T, 'GET', `/v1/campanhas/${id}/audiencia`)
    expect((aud.json() as { total: number }).total).toBeGreaterThanOrEqual(1)

    const d1 = await chamar(T, 'POST', `/v1/campanhas/${id}/disparar`)
    expect(d1.statusCode).toBe(200)
    expect((d1.json() as { enfileirados: number }).enfileirados).toBeGreaterThanOrEqual(1)
    const d2 = await chamar(T, 'POST', `/v1/campanhas/${id}/disparar`)
    expect(d2.statusCode).toBe(409) // já disparada
    const [c] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM campanha_envio WHERE tenant_id=${T} AND campanha_id=${id}`
    expect(c!.n).toBe(1) // não duplicou
  })

  it('⚠️ isolamento: campanha de um tenant não aparece para outro (RLS)', async () => {
    await criarCampanha(OUTRO)
    const doT = await chamar(T, 'GET', '/v1/campanhas')
    expect((doT.json() as { itens: unknown[] }).itens.length).toBe(0)
  })
})
