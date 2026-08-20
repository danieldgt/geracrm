import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { roiDaVeiculacao } from './roi.js'
import type { Sql } from '../../db/index.js'

/**
 * ROI de veiculação (AQ-16) — a afirmação central do produto.
 *
 * ⚠️ O cenário é montado para exercitar exatamente onde primeiro e último toque
 * DIVERGEM. Um teste com um toque por contato passaria com qualquer modelo e não
 * provaria nada sobre o que o módulo existe para dizer.
 */

const T = '40a00000-0000-4000-8000-000000000001'
const PV = '40a00000-1111-4000-8000-000000000001'
const PLANO = '40a00000-3333-4000-8000-000000000001'
const MODELO = '40a00000-4444-4000-8000-000000000001'
const CONTA = '40a00000-7777-4000-8000-000000000001'
const CAMP = '40a00000-8888-4000-8000-000000000001'
const CONJ = '40a00000-9999-4000-8000-000000000001'
const AD_A = '40a00000-aaaa-4000-8000-00000000000a'
const AD_B = '40a00000-aaaa-4000-8000-00000000000b'
/** Contato de UM toque só (A) — os dois modelos concordam sobre ele. */
const SO_A = '40a00000-6666-4000-8000-00000000000a'
/** Contato tocado por A e depois por B — é aqui que os modelos divergem. */
const A_DEPOIS_B = '40a00000-6666-4000-8000-00000000000b'
/** Contato que comprou e teve a venda CANCELADA. */
const CANCELADO = '40a00000-6666-4000-8000-00000000000c'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const api = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => {} })

async function comoTenant<T2>(fn: (tx: Sql) => Promise<T2>): Promise<T2> {
  return api.begin(async (tx) => {
    await tx`SELECT set_config('geracrm.tenant_id', ${T}, true)`
    return fn(tx as unknown as Sql)
  }) as Promise<T2>
}

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-teste-roi', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-teste-roi', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id)
             VALUES (${T}, 'Loja ROI', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome)
             VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })

  await dono`INSERT INTO midia_conta (tenant_id, id, plataforma, id_externo, nome)
             VALUES (${T}, ${CONTA}, 'google', 'roi-conta', 'Conta') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO midia_campanha (tenant_id, id, conta_id, id_externo, nome)
             VALUES (${T}, ${CAMP}, ${CONTA}, 'roi-camp', 'Camp') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO midia_conjunto (tenant_id, id, campanha_id, id_externo, nome)
             VALUES (${T}, ${CONJ}, ${CAMP}, 'roi-conj', 'Conj') ON CONFLICT DO NOTHING`
  for (const [id, ext] of [[AD_A, 'roi-ad-a'], [AD_B, 'roi-ad-b']] as const) {
    await dono`INSERT INTO midia_anuncio (tenant_id, id, conjunto_id, id_externo, nome)
               VALUES (${T}, ${id}, ${CONJ}, ${ext}, 'Anúncio') ON CONFLICT DO NOTHING`
  }

  // Custo: R$ 100,00 no anúncio A, R$ 50,00 no B.
  await dono`INSERT INTO midia_metrica_dia (tenant_id, anuncio_id, dia, impressoes, cliques, custo_centavos)
             VALUES (${T}, ${AD_A}, '2026-08-01', 1000, 50, 10000),
                    (${T}, ${AD_B}, '2026-08-01', 500, 20, 5000)`

  for (const c of [SO_A, A_DEPOIS_B, CANCELADO]) {
    await dono`INSERT INTO contato (tenant_id, id, nome) VALUES (${T}, ${c}, 'Lead') ON CONFLICT DO NOTHING`
  }

  // SO_A: um toque só, no anúncio A.
  await dono`INSERT INTO midia_lead_origem (tenant_id, id, contato_id, anuncio_id, primeira, capturado_em)
             VALUES (${T}, gen_random_uuid(), ${SO_A}, ${AD_A}, true, '2026-08-01T10:00:00Z')`

  // A_DEPOIS_B: primeiro toque em A, segundo em B — a divergência.
  await dono`INSERT INTO midia_lead_origem (tenant_id, id, contato_id, anuncio_id, primeira, capturado_em)
             VALUES (${T}, gen_random_uuid(), ${A_DEPOIS_B}, ${AD_A}, true,  '2026-08-01T11:00:00Z'),
                    (${T}, gen_random_uuid(), ${A_DEPOIS_B}, ${AD_B}, false, '2026-08-03T11:00:00Z')`

  // CANCELADO: toque em A, comprou, venda cancelada.
  await dono`INSERT INTO midia_lead_origem (tenant_id, id, contato_id, anuncio_id, primeira, capturado_em)
             VALUES (${T}, gen_random_uuid(), ${CANCELADO}, ${AD_A}, true, '2026-08-01T12:00:00Z')`

  // Vendas: R$ 300 (SO_A) e R$ 500 (A_DEPOIS_B), ambas dentro da janela.
  await dono`INSERT INTO venda (tenant_id, id, contato_id, ocorrida_em, valor_centavos)
             VALUES (${T}, gen_random_uuid(), ${SO_A},      '2026-08-05T10:00:00Z', 30000),
                    (${T}, gen_random_uuid(), ${A_DEPOIS_B},'2026-08-05T10:00:00Z', 50000)`
  // ⚠️ Cancelada: não pode entrar em receita nenhuma.
  await dono`INSERT INTO venda (tenant_id, id, contato_id, ocorrida_em, valor_centavos, cancelada_em)
             VALUES (${T}, gen_random_uuid(), ${CANCELADO}, '2026-08-05T10:00:00Z', 99900, now())`
})

afterAll(async () => {
  await dono`DELETE FROM venda            WHERE tenant_id = ${T}`
  await dono`DELETE FROM midia_lead_origem WHERE tenant_id = ${T}`
  await dono`DELETE FROM midia_metrica_dia WHERE tenant_id = ${T}`
  await dono`DELETE FROM midia_conta      WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato          WHERE tenant_id = ${T}`
  await dono.end()
  await api.end()
})

const consulta = { de: '2026-08-01', ate: '2026-08-10', janelaDias: 14 } as const

describe('Os fatos', () => {
  it('custo, impressões e cliques vêm da plataforma, só do anúncio pedido', async () => {
    const r = await comoTenant((tx) => roiDaVeiculacao(tx, { ...consulta, anuncioId: AD_A, modelo: 'primeiro_toque' }))
    expect(r.custoCentavos).toBe(10000)
    expect(r.impressoes).toBe(1000)
    expect(r.cliques).toBe(50)
  })

  it('leads é contagem de origem registrada — 3 no anúncio A', async () => {
    const r = await comoTenant((tx) => roiDaVeiculacao(tx, { ...consulta, anuncioId: AD_A, modelo: 'primeiro_toque' }))
    expect(r.leads).toBe(3)
    // R$ 100,00 ÷ 3 leads = R$ 33,33
    expect(r.custoPorLeadCentavos).toBe(3333)
  })

  it('sem leads, custo por lead é null — nunca Infinity', async () => {
    const r = await comoTenant((tx) => roiDaVeiculacao(tx, {
      ...consulta, de: '2026-09-01', ate: '2026-09-10', anuncioId: AD_A, modelo: 'primeiro_toque',
    }))
    expect(r.leads).toBe(0)
    expect(r.custoPorLeadCentavos).toBeNull()
    expect(r.atribuicao.roas).toBeNull()
  })
})

describe('⚠️ Onde os dois modelos DIVERGEM', () => {
  it('primeiro toque credita ao A as duas vendas — R$ 800', async () => {
    const r = await comoTenant((tx) => roiDaVeiculacao(tx, { ...consulta, anuncioId: AD_A, modelo: 'primeiro_toque' }))
    expect(r.atribuicao.vendas).toBe(2)
    expect(r.atribuicao.receitaCentavos).toBe(80000)
    expect(r.atribuicao.roas).toBe(8) // 80000 ÷ 10000
  })

  it('último toque credita ao A só uma — a outra foi para o B', async () => {
    const r = await comoTenant((tx) => roiDaVeiculacao(tx, { ...consulta, anuncioId: AD_A, modelo: 'ultimo_toque' }))
    expect(r.atribuicao.vendas).toBe(1)
    expect(r.atribuicao.receitaCentavos).toBe(30000)
  })

  it('e o B, que não existia no primeiro toque, aparece no último', async () => {
    const primeiro = await comoTenant((tx) => roiDaVeiculacao(tx, { ...consulta, anuncioId: AD_B, modelo: 'primeiro_toque' }))
    const ultimo = await comoTenant((tx) => roiDaVeiculacao(tx, { ...consulta, anuncioId: AD_B, modelo: 'ultimo_toque' }))
    expect(primeiro.atribuicao.receitaCentavos).toBe(0)
    expect(ultimo.atribuicao.receitaCentavos).toBe(50000)
  })

  /**
   * ⚠️ A propriedade que dá honestidade ao número: o subconjunto de contatos com
   * UM ÚNICO toque não depende do modelo. A distância entre ele e o total mede
   * quanto do ROAS é artefato de modelagem.
   */
  it('o sem-ambiguidade é IGUAL nos dois modelos', async () => {
    const primeiro = await comoTenant((tx) => roiDaVeiculacao(tx, { ...consulta, anuncioId: AD_A, modelo: 'primeiro_toque' }))
    const ultimo = await comoTenant((tx) => roiDaVeiculacao(tx, { ...consulta, anuncioId: AD_A, modelo: 'ultimo_toque' }))
    expect(primeiro.semAmbiguidade).toEqual(ultimo.semAmbiguidade)
    expect(primeiro.semAmbiguidade.receitaCentavos).toBe(30000) // só o SO_A
  })

  it('e ele é sempre ≤ o atribuído — é um subconjunto', async () => {
    for (const modelo of ['primeiro_toque', 'ultimo_toque'] as const) {
      const r = await comoTenant((tx) => roiDaVeiculacao(tx, { ...consulta, anuncioId: AD_A, modelo }))
      expect(r.semAmbiguidade.receitaCentavos).toBeLessThanOrEqual(r.atribuicao.receitaCentavos)
      expect(r.semAmbiguidade.vendas).toBeLessThanOrEqual(r.atribuicao.vendas)
    }
  })
})

describe('O que NÃO entra na receita', () => {
  // ⚠️ A convenção da casa (BI, painel, funil) — e o erro que infla o número
  //    justamente na direção que agrada.
  it('venda cancelada não conta em nenhum modelo', async () => {
    for (const modelo of ['primeiro_toque', 'ultimo_toque'] as const) {
      const r = await comoTenant((tx) => roiDaVeiculacao(tx, { ...consulta, anuncioId: AD_A, modelo }))
      expect(r.atribuicao.receitaCentavos).not.toBe(179900) // 800 + 999 cancelada
      expect(r.atribuicao.vendas).toBeLessThanOrEqual(2)
    }
  })

  it('venda fora da janela não conta', async () => {
    const r = await comoTenant((tx) => roiDaVeiculacao(tx, {
      ...consulta, anuncioId: AD_A, modelo: 'primeiro_toque', janelaDias: 1,
    }))
    // Toque em 01/08, venda em 05/08: fora de uma janela de 1 dia.
    expect(r.atribuicao.vendas).toBe(0)
    expect(r.atribuicao.receitaCentavos).toBe(0)
  })

  it('a janela declarada volta na resposta — o número não viaja sem ela', async () => {
    const r = await comoTenant((tx) => roiDaVeiculacao(tx, { ...consulta, anuncioId: AD_A, modelo: 'ultimo_toque' }))
    expect(r.atribuicao.janelaDias).toBe(14)
    expect(r.atribuicao.modelo).toBe('ultimo_toque')
  })
})
