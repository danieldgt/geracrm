import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { distribuicaoRfv } from './rotas-segmentos.js'

/** Segmentos RFV — distribuição da base por segmento (reusa classificarRfv). */
const T = 'd5e60000-0000-4000-8000-000000000001'
const PV = 'd5e60000-1111-4000-8000-000000000001'
const PLANO = 'd5e60000-3333-4000-8000-000000000001'
const MODELO = 'd5e60000-4444-4000-8000-000000000001'
const C1 = 'd5e60000-6666-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const api = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => {} })
const comoT = <X>(fn: (tx: postgres.Sql) => Promise<X>) => api.begin(async (tx) => {
  await tx`SELECT set_config('geracrm.tenant_id', ${T}, true)`
  return fn(tx as unknown as postgres.Sql)
}) as Promise<X>

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-seg', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-seg', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'Loja Seg', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES (${T}, ${C1}, 'Cliente', 'teste', true) ON CONFLICT DO NOTHING`
  // Uma venda recente → contato "cliente novo" (1 compra, recente).
  await dono`INSERT INTO venda (tenant_id, id, contato_id, ocorrida_em, valor_centavos)
             VALUES (${T}, ${randomUUID()}, ${C1}, now() - interval '5 days', 25000)`
  await dono`SELECT atualizar_metricas_contato()`
})

afterAll(async () => {
  await dono`DELETE FROM venda WHERE tenant_id = ${T}`
  await dono`SELECT atualizar_metricas_contato()`
  await dono`DELETE FROM contato WHERE tenant_id = ${T}`
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${T}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${T}`
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await dono.end(); await api.end()
})

describe('distribuicaoRfv', () => {
  it('agrupa a base por segmento com contagem e receita, ordenada por urgência', async () => {
    const itens = await comoT((tx) => distribuicaoRfv(tx))
    const total = itens.reduce((s, i) => s + i.contatos, 0)
    expect(total).toBeGreaterThanOrEqual(1)
    // O cliente com 1 compra há 5 dias cai em 'cliente-recente'.
    const recente = itens.find((i) => i.codigo === 'cliente-recente')
    expect(recente).toBeDefined()
    expect(recente!.contatos).toBeGreaterThanOrEqual(1)
    expect(recente!.receitaCentavos).toBeGreaterThanOrEqual(25000)
    // Ordenação por urgência decrescente.
    for (let i = 1; i < itens.length; i++) expect(itens[i - 1]!.urgencia).toBeGreaterThanOrEqual(itens[i]!.urgencia)
  })
})
