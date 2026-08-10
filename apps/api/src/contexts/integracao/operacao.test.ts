import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { registrarOperacao } from './operacao.js'

/**
 * INT-08 — o painel de sincronização lê de `operacao_ingestao`. Dois riscos:
 *   1. o helper precisa gravar o que cada fluxo trouxe e rejeitou (sem isso, o
 *      resultado da carga só existe no stdout do worker);
 *   2. a leitura passa por RLS — um tenant NUNCA vê a operação de outro. A
 *      ingestão roda como dono (ignora RLS), mas a TELA lê sob RLS.
 */
const A = 'a08c0000-0000-4000-8000-000000000001'
const B = 'a08c0000-0000-4000-8000-000000000002'
const PVA = 'a08c0000-1111-4000-8000-000000000001'
const PVB = 'a08c0000-1111-4000-8000-000000000002'
const PLANO = 'a08c0000-3333-4000-8000-000000000001'
const MODELO = 'a08c0000-4444-4000-8000-000000000001'
const CONEXAO_A = 'a08c0000-2222-4000-8000-000000000001'
const CONEXAO_B = 'a08c0000-2222-4000-8000-000000000002'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const api = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => {} })

/** Executa como a API executa: SET LOCAL do tenant dentro da transação. */
async function comoTenant<T>(tenantId: string, fn: (tx: postgres.Sql) => Promise<T>): Promise<T> {
  return api.begin(async (tx) => {
    await tx`SELECT set_config('geracrm.tenant_id', ${tenantId}, true)`
    return fn(tx as unknown as postgres.Sql)
  }) as Promise<T>
}

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-int08', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-int08', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome, cx] of [[A, PVA, 'Loja A', CONEXAO_A], [B, PVB, 'Loja B', CONEXAO_B]] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
    await dono`INSERT INTO conexao_erp (tenant_id, id, conector, nome_amigavel, fonte_de_venda, estado)
               VALUES (${t}, ${cx}, 'geracloud', 'ERP', true, 'ativa') ON CONFLICT DO NOTHING`
  }
})

afterAll(async () => {
  for (const t of [A, B]) {
    await dono`DELETE FROM operacao_ingestao WHERE tenant_id = ${t}`
    await dono`DELETE FROM conexao_erp WHERE tenant_id = ${t}`
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await dono.end()
  await api.end()
})

describe('INT-08: registro de operação de ingestão', () => {
  it('grava o que o fluxo trouxe e rejeitou', async () => {
    await dono`DELETE FROM operacao_ingestao WHERE tenant_id = ${A}`
    await registrarOperacao(dono as never, {
      tenantId: A, conexaoId: CONEXAO_A, fluxo: 'customers',
      total: 100, aceitos: 97, rejeitados: 3, rejeicoes: [{ linha: 4, motivo: 'sem cnpj' }],
    })
    const [op] = await dono<{ fluxo: string; total: number; aceitos: number; rejeitados: number; estado: string; rej: number }[]>`
      SELECT fluxo, total, aceitos, rejeitados, estado, jsonb_array_length(rejeicoes) AS rej
        FROM operacao_ingestao WHERE tenant_id = ${A}`
    expect(op).toMatchObject({ fluxo: 'customers', total: 100, aceitos: 97, rejeitados: 3, estado: 'concluida' })
    expect(op!.rej).toBe(1)
  })

  it('trunca a amostra de rejeições em 100 — a operação registra, não arquiva tudo', async () => {
    await dono`DELETE FROM operacao_ingestao WHERE tenant_id = ${A}`
    const muitas = Array.from({ length: 250 }, (_, i) => ({ linha: i, motivo: 'x' }))
    await registrarOperacao(dono as never, {
      tenantId: A, conexaoId: CONEXAO_A, fluxo: 'orders', total: 250, aceitos: 0, rejeitados: 250, rejeicoes: muitas,
    })
    const [op] = await dono<{ rej: number }[]>`
      SELECT jsonb_array_length(rejeicoes) AS rej FROM operacao_ingestao WHERE tenant_id = ${A}`
    expect(op!.rej).toBe(100)
  })

  it('⚠️ isolamento: a tela de um tenant NUNCA lê a operação de outro (RLS)', async () => {
    await dono`DELETE FROM operacao_ingestao WHERE tenant_id IN (${A}, ${B})`
    await registrarOperacao(dono as never, { tenantId: A, conexaoId: CONEXAO_A, fluxo: 'products', total: 10, aceitos: 10, rejeitados: 0 })
    await registrarOperacao(dono as never, { tenantId: B, conexaoId: CONEXAO_B, fluxo: 'products', total: 20, aceitos: 20, rejeitados: 0 })

    // A leitura da rota (SELECT ... WHERE tenant_id = tenant_atual()) sob RLS.
    const daLojaA = await comoTenant(A, (tx) => tx<{ total: number }[]>`
      SELECT total FROM operacao_ingestao WHERE tenant_id = tenant_atual() ORDER BY iniciado_em DESC LIMIT 30`)
    expect(daLojaA.map((o) => o.total)).toEqual([10])
    expect(daLojaA.some((o) => o.total === 20)).toBe(false)
  })
})
