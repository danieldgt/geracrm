import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'

/** BI (rankings de venda) + Performance (SLA/1ª resposta). Leitura agregada. */
const T = 'a5a70000-0000-4000-8000-000000000001'
const OUTRO = 'a5a70000-0000-4000-8000-000000000002'
const PV = 'a5a70000-1111-4000-8000-000000000001'
const PV2 = 'a5a70000-1111-4000-8000-000000000002'
const PLANO = 'a5a70000-3333-4000-8000-000000000001'
const MODELO = 'a5a70000-4444-4000-8000-000000000001'
const VEND = 'a5a70000-5555-4000-8000-000000000001'
const C1 = 'a5a70000-6666-4000-8000-000000000001'
const CANAL = 'a5a70000-7777-4000-8000-000000000001'
const CONV = 'a5a70000-8888-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const chamar = (t: string, url: string) => app.inject({ method: 'GET', url, headers: { 'x-tenant-id': t } })

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-an', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-an', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'A'], [OUTRO, PV2, 'B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${T}, ${VEND}, ${'sub-' + VEND}, 'Ana', 'ana@ex.com') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES (${T}, ${C1}, 'Cliente BI', 'teste', true) ON CONFLICT DO NOTHING`

  // Vendas para BI: uma boa (entra) e uma cancelada (fica de fora).
  // ⚠️ item_venda casa com venda pela CHAVE DE PARTIÇÃO (ocorrida_em); precisa ser
  // exatamente o mesmo timestamp nos dois inserts — não dois `now()` separados.
  const boa = randomUUID()
  const ocorrida = new Date(Date.now() - 2 * 86400000).toISOString()
  await dono`INSERT INTO venda (tenant_id, id, contato_id, ocorrida_em, valor_centavos, usuario_id)
             VALUES (${T}, ${boa}, ${C1}, ${ocorrida}, 50000, ${VEND})`
  await dono`INSERT INTO venda (tenant_id, id, contato_id, ocorrida_em, valor_centavos, usuario_id, cancelada_em)
             VALUES (${T}, ${randomUUID()}, ${C1}, ${ocorrida}, 99999, ${VEND}, now())`
  await dono`INSERT INTO item_venda (tenant_id, venda_id, venda_ocorrida_em, seq, sku_externo, quantidade, valor_unitario_centavos)
             VALUES (${T}, ${boa}, ${ocorrida}, 1, 'Camisa Azul', 10, 5000)`

  // Atendimento para Performance: chegou, foi respondido por humano em 2 min (dentro do SLA de 5).
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado)
             VALUES (${T}, ${CANAL}, 'whatsapp_oficial', 'Zap', 'conectado') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id) VALUES (${T}, ${CONV}, ${CANAL}, ${C1}) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO atendimento (tenant_id, id, conversa_id, canal_id, protocolo, estado, criado_em,
                                      primeira_entrante_em, primeira_resposta_humana_em, primeira_resposta_por_id)
             VALUES (${T}, ${randomUUID()}, ${CONV}, ${CANAL}, ${Date.now()}, 'encerrado', now() - interval '1 day',
                     now() - interval '1 day', now() - interval '1 day' + interval '2 minutes', ${VEND})`
  app = await criarApp(); await app.ready()
})

afterAll(async () => {
  await dono`DELETE FROM item_venda WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM venda WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM atendimento WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM conversa WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM canal_conectado WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM contato WHERE tenant_id IN (${T}, ${OUTRO})`
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

describe('BI de vendas', () => {
  it('⚠️ ranking exclui vendas canceladas; agrega cliente, produto e vendedor', async () => {
    const r = (await chamar(T, '/v1/bi?dias=30')).json() as {
      topClientes: { contatoId: string; receitaCentavos: number }[]
      topProdutos: { rotulo: string; quantidade: number; receitaCentavos: number }[]
      porVendedor: { usuarioId: string | null; receitaCentavos: number }[]
    }
    const cli = r.topClientes.find((c) => c.contatoId === C1)
    expect(cli?.receitaCentavos).toBe(50000) // a cancelada (99999) ficou fora
    const prod = r.topProdutos.find((p) => p.rotulo === 'Camisa Azul')
    expect(prod).toMatchObject({ quantidade: 10, receitaCentavos: 50000 })
    const vend = r.porVendedor.find((v) => v.usuarioId === VEND)
    expect(vend?.receitaCentavos).toBe(50000)
  })

  it('⚠️ isolamento: BI de um tenant não enxerga vendas de outro', async () => {
    const r = (await chamar(OUTRO, '/v1/bi?dias=30')).json() as { topClientes: unknown[]; porVendedor: unknown[] }
    expect(r.topClientes.length).toBe(0)
  })
})

describe('Performance de atendimento', () => {
  it('mede 1ª resposta humana e % dentro do SLA', async () => {
    const r = (await chamar(T, '/v1/performance?dias=30')).json() as {
      total: number; respondidos: number; dentroSla: number; pctDentroSla: number | null
      medianaRespostaSeg: number | null; slaMinutos: number
      porAtendente: { usuarioId: string | null; respondidos: number }[]
    }
    expect(r.total).toBeGreaterThanOrEqual(1)
    expect(r.respondidos).toBeGreaterThanOrEqual(1)
    expect(r.dentroSla).toBeGreaterThanOrEqual(1) // 2 min < 5 min de SLA
    expect(r.pctDentroSla).toBe(100)
    expect(r.medianaRespostaSeg).toBe(120) // 2 minutos
    expect(r.porAtendente.find((a) => a.usuarioId === VEND)?.respondidos).toBe(1)
  })

  it('⚠️ isolamento: Performance de um tenant não vê atendimentos de outro', async () => {
    const r = (await chamar(OUTRO, '/v1/performance?dias=30')).json() as { total: number }
    expect(r.total).toBe(0)
  })
})
