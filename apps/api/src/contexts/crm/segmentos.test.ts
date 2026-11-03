import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { classificarRfv } from '@geracrm/shared'
import { distribuicaoRfv } from './rotas-segmentos.js'

/** Segmentos RFV — distribuição da base por segmento (reusa classificarRfv). */
const T = 'd5e60000-0000-4000-8000-000000000001'
const PV = 'd5e60000-1111-4000-8000-000000000001'
const PLANO = 'd5e60000-3333-4000-8000-000000000001'
const MODELO = 'd5e60000-4444-4000-8000-000000000001'
const C1 = 'd5e60000-6666-4000-8000-000000000001'
const T2 = 'd5e60000-0000-4000-8000-000000000002'
const PV2 = 'd5e60000-1111-4000-8000-000000000002'
// [contato, dias atrás de cada venda] — cobre as faixas do RFV; o último não compra (sem linha de métricas).
const CENARIOS: [string, number[]][] = [
  ['d5e60000-6666-4000-8000-000000000011', [5]], // sem ritmo, recente
  ['d5e60000-6666-4000-8000-000000000012', [300]], // sem ritmo, parado
  ['d5e60000-6666-4000-8000-000000000013', [100, 70, 40, 10]], // ritmo 30d, 10 sem comprar: em dia
  ['d5e60000-6666-4000-8000-000000000014', [140, 110, 80, 30]], // atraso ~1: na hora
  ['d5e60000-6666-4000-8000-000000000015', [400, 300, 200]], // atraso 2: em risco
  ['d5e60000-6666-4000-8000-000000000016', [500, 400, 300]], // atraso 3
  ['d5e60000-6666-4000-8000-000000000017', [1000, 900, 800]], // atraso 8: hibernando
  ['d5e60000-6666-4000-8000-000000000018', []],
]

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const api = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => {} })
const comoTenant = <X>(t: string, fn: (tx: postgres.Sql) => Promise<X>) => api.begin(async (tx) => {
  await tx`SELECT set_config('geracrm.tenant_id', ${t}, true)`
  return fn(tx as unknown as postgres.Sql)
}) as Promise<X>
const comoT = <X>(fn: (tx: postgres.Sql) => Promise<X>) => comoTenant(T, fn)

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-seg', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-seg', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'Loja Seg', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T2}, 'Loja Seg 2', ${PLANO}, ${PV2}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T2}, ${PV2}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  for (const [t, cs] of [[T, CENARIOS], [T2, CENARIOS.slice(0, 3)]] as const) {
    for (const [c, dias] of cs) {
      await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES (${t}, ${c}, 'C', 'teste', true) ON CONFLICT DO NOTHING`
      for (const d of dias) {
        await dono`INSERT INTO venda (tenant_id, id, contato_id, ocorrida_em, valor_centavos)
                   VALUES (${t}, ${randomUUID()}, ${c}, now() - ${d + ' days'}::interval, 10000)`
      }
    }
  }
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES (${T}, ${C1}, 'Cliente', 'teste', true) ON CONFLICT DO NOTHING`
  // Uma venda recente → contato "cliente novo" (1 compra, recente).
  await dono`INSERT INTO venda (tenant_id, id, contato_id, ocorrida_em, valor_centavos)
             VALUES (${T}, ${randomUUID()}, ${C1}, now() - interval '5 days', 25000)`
  await dono`SELECT atualizar_metricas_contato()`
})

afterAll(async () => {
  await dono`DELETE FROM venda WHERE tenant_id IN (${T}, ${T2})`
  await dono`SELECT atualizar_metricas_contato()`
  await dono`DELETE FROM contato WHERE tenant_id IN (${T}, ${T2})`
  for (const t of [T, T2]) {
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
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

  it('o GROUP BY no SQL dá o mesmo resultado da classificação linha a linha (dois tenants)', async () => {
    // Referência: a implementação anterior (lê todas as linhas e classifica em memória).
    const legado = async (t: string) => comoTenant(t, async (tx) => {
      const linhas = await tx<{ qtd_vendas: number; dias_sem_comprar: number | null; atraso_relativo: string | null; total_centavos: string }[]>`
        SELECT qtd_vendas, dias_sem_comprar, atraso_relativo::text, total_centavos::text FROM metricas_contato WHERE tenant_id = tenant_atual()`
      const m = new Map<string, { contatos: number; receitaCentavos: number; urgencia: number }>()
      for (const l of linhas) {
        const s = classificarRfv({ qtdVendas: Number(l.qtd_vendas), diasSemComprar: l.dias_sem_comprar,
          atrasoRelativo: l.atraso_relativo === null ? null : Number(l.atraso_relativo) })
        const a = m.get(s.codigo) ?? { contatos: 0, receitaCentavos: 0, urgencia: s.urgencia }
        a.contatos += 1; a.receitaCentavos += Number(l.total_centavos); m.set(s.codigo, a)
      }
      return m
    })
    for (const t of [T, T2]) {
      const esperado = await legado(t)
      const itens = await comoTenant(t, (tx) => distribuicaoRfv(tx))
      expect(itens.length).toBe(esperado.size)
      for (const i of itens) {
        expect({ contatos: i.contatos, receitaCentavos: i.receitaCentavos }).toEqual(
          { contatos: esperado.get(i.codigo)!.contatos, receitaCentavos: esperado.get(i.codigo)!.receitaCentavos })
      }
    }
    const a = await comoTenant(T, (tx) => distribuicaoRfv(tx))
    const b = await comoTenant(T2, (tx) => distribuicaoRfv(tx))
    expect(a.reduce((s, i) => s + i.contatos, 0)).toBe(CENARIOS.length - 1 + 1) // 7 com compra + C1 (sem o contato sem venda)
    expect(b.reduce((s, i) => s + i.contatos, 0)).toBe(3)
    expect(a.map((i) => i.codigo)).toEqual(expect.arrayContaining(['cliente-recente', 'em-risco', 'hibernando', 'cliente-fiel']))
  })
})
