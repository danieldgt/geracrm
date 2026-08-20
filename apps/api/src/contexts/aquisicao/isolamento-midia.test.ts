import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'

/**
 * Isolamento e invariantes do schema de mídia (0058/0059).
 *
 * ⚠️ Roda com o papel geracrm_api — sem superusuário e sem BYPASSRLS. Testar
 * isolamento com a conexão de dono passa sempre e não prova nada.
 */

const A = 'ad00ad00-0000-4000-8000-000000000001'
const B = 'ad00ad00-0000-4000-8000-000000000002'
const PVA = 'ad00ad00-1111-4000-8000-000000000001'
const PVB = 'ad00ad00-1111-4000-8000-000000000002'
const PLANO = 'ad00ad00-3333-4000-8000-000000000001'
const MODELO = 'ad00ad00-4444-4000-8000-000000000001'
const CONTATO_A = 'ad00ad00-6666-4000-8000-00000000000a'
const CONTA_A = 'ad00ad00-7777-4000-8000-00000000000a'
const CONTA_B = 'ad00ad00-7777-4000-8000-00000000000b'
const CAMP_A = 'ad00ad00-8888-4000-8000-00000000000a'
const CONJ_A = 'ad00ad00-9999-4000-8000-00000000000a'
const ANUN_A = 'ad00ad00-aaaa-4000-8000-00000000000a'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const api = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => {} })

/** Executa como a API executa: SET LOCAL dentro da transação. */
async function comoTenant<T>(tenantId: string, fn: (tx: postgres.Sql) => Promise<T>): Promise<T> {
  return api.begin(async (tx) => {
    await tx`SELECT set_config('geracrm.tenant_id', ${tenantId}, true)`
    return fn(tx as unknown as postgres.Sql)
  }) as Promise<T>
}

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-teste-midia', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-teste-midia', 'Varejo') ON CONFLICT DO NOTHING`

  for (const [t, pv, nome] of [[A, PVA, 'Loja A'], [B, PVB, 'Loja B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id)
               VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome)
               VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }

  await dono`INSERT INTO contato (tenant_id, id, nome) VALUES (${A}, ${CONTATO_A}, 'Lead do anúncio') ON CONFLICT DO NOTHING`

  // A MESMA conta externa nos dois tenants — prova que a unicidade é POR TENANT.
  for (const [t, id] of [[A, CONTA_A], [B, CONTA_B]] as const) {
    await dono`INSERT INTO midia_conta (tenant_id, id, plataforma, id_externo, nome)
               VALUES (${t}, ${id}, 'google', '123-456-7890', 'Conta Ads') ON CONFLICT DO NOTHING`
  }

  await dono`INSERT INTO midia_campanha (tenant_id, id, conta_id, id_externo, nome)
             VALUES (${A}, ${CAMP_A}, ${CONTA_A}, 'c-1', 'Coleção Verão') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO midia_conjunto (tenant_id, id, campanha_id, id_externo, nome)
             VALUES (${A}, ${CONJ_A}, ${CAMP_A}, 'g-1', 'Grupo 1') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO midia_anuncio (tenant_id, id, conjunto_id, id_externo, nome)
             VALUES (${A}, ${ANUN_A}, ${CONJ_A}, 'a-1', 'Anúncio 1') ON CONFLICT DO NOTHING`
})

afterAll(async () => {
  await dono`DELETE FROM midia_lead_origem WHERE tenant_id IN (${A}, ${B})`
  await dono`DELETE FROM midia_sessao_lp   WHERE tenant_id IN (${A}, ${B})`
  await dono`DELETE FROM midia_metrica_dia WHERE tenant_id IN (${A}, ${B})`
  await dono`DELETE FROM midia_conta       WHERE tenant_id IN (${A}, ${B})`
  await dono`DELETE FROM contato           WHERE tenant_id IN (${A}, ${B})`
  await dono.end()
  await api.end()
})

describe('RLS das tabelas de mídia', () => {
  it('tenant A não enxerga a conta de anúncio do tenant B', async () => {
    const linhas = await comoTenant(A, (tx) => tx<{ id: string }[]>`SELECT id FROM midia_conta`)
    expect(linhas.map((l) => l.id)).toEqual([CONTA_A])
  })

  it('tenant B não enxerga a campanha do tenant A', async () => {
    const linhas = await comoTenant(B, (tx) => tx`SELECT id FROM midia_campanha`)
    expect(linhas).toHaveLength(0)
  })

  it('a mesma conta externa convive nos dois tenants (unicidade é composta)', async () => {
    const [a] = await comoTenant(A, (tx) => tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM midia_conta WHERE id_externo = '123-456-7890'`)
    const [b] = await comoTenant(B, (tx) => tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM midia_conta WHERE id_externo = '123-456-7890'`)
    expect([a!.n, b!.n]).toEqual([1, 1])
  })
})

describe('INV-61 — um só primeiro toque por contato', () => {
  it('o segundo `primeira` no mesmo contato é recusado', async () => {
    await dono`INSERT INTO midia_lead_origem (tenant_id, id, contato_id, primeira, anuncio_externo_id)
               VALUES (${A}, gen_random_uuid(), ${CONTATO_A}, true, 'a-1')`

    await expect(
      dono`INSERT INTO midia_lead_origem (tenant_id, id, contato_id, primeira, anuncio_externo_id)
           VALUES (${A}, gen_random_uuid(), ${CONTATO_A}, true, 'a-2')`,
    ).rejects.toThrow(/midia_origem_primeira_unica/)
  })

  it('mas o contato aceita vários toques NÃO-primeiros (1:N)', async () => {
    for (const ad of ['a-2', 'a-3']) {
      await dono`INSERT INTO midia_lead_origem (tenant_id, id, contato_id, primeira, anuncio_externo_id)
                 VALUES (${A}, gen_random_uuid(), ${CONTATO_A}, false, ${ad})`
    }
    const [c] = await comoTenant(A, (tx) => tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM midia_lead_origem WHERE contato_id = ${CONTATO_A}`)
    expect(c!.n).toBe(3)
  })
})

describe('Invariantes de coluna', () => {
  it('modo_entrada só aceita os dois modos declarados (AMK-016)', async () => {
    await expect(
      dono`INSERT INTO midia_campanha (tenant_id, id, conta_id, id_externo, nome, modo_entrada)
           VALUES (${A}, gen_random_uuid(), ${CONTA_A}, 'c-x', 'X', 'qualquer_coisa')`,
    ).rejects.toThrow(/midia_campanha_modo_valido/)
  })

  it('consentimento é par — texto sem data é recusado (LGPD)', async () => {
    await expect(
      dono`INSERT INTO midia_lead_origem (tenant_id, id, contato_id, consentimento_texto)
           VALUES (${A}, gen_random_uuid(), ${CONTATO_A}, 'Aceito receber contato')`,
    ).rejects.toThrow(/midia_origem_consentimento_coerente/)
  })

  it('custo em centavos é bigint e volta como string — cast explícito é obrigatório', async () => {
    await dono`INSERT INTO midia_metrica_dia (tenant_id, anuncio_id, dia, custo_centavos, cliques)
               VALUES (${A}, ${ANUN_A}, current_date, 9007199254740993, 10)`
    const [cru] = await comoTenant(A, (tx) => tx<{ custo_centavos: unknown }[]>`
      SELECT custo_centavos FROM midia_metrica_dia WHERE anuncio_id = ${ANUN_A}`)
    // ⚠️ É o comportamento correto do driver: bigint excede MAX_SAFE_INTEGER.
    expect(typeof cru!.custo_centavos).toBe('string')

    const [somado] = await comoTenant(A, (tx) => tx<{ total: string }[]>`
      SELECT coalesce(sum(custo_centavos), 0)::text AS total FROM midia_metrica_dia`)
    expect(somado!.total).toBe('9007199254740993')
  })

  it('métrica negativa é recusada', async () => {
    await expect(
      dono`INSERT INTO midia_metrica_dia (tenant_id, anuncio_id, dia, custo_centavos)
           VALUES (${A}, ${ANUN_A}, current_date - 1, -1)`,
    ).rejects.toThrow(/midia_metrica_nao_negativa/)
  })

  it('a sincronização é UPSERT — o dia reescrito atualiza, não duplica', async () => {
    const dia = '2026-08-01'
    for (const custo of [1000, 2500]) {
      await dono`INSERT INTO midia_metrica_dia (tenant_id, anuncio_id, dia, custo_centavos)
                 VALUES (${A}, ${ANUN_A}, ${dia}, ${custo})
                 ON CONFLICT (tenant_id, anuncio_id, dia)
                 DO UPDATE SET custo_centavos = EXCLUDED.custo_centavos, atualizado_em = now()`
    }
    const [r] = await comoTenant(A, (tx) => tx<{ n: number; custo: string }[]>`
      SELECT count(*)::int AS n, max(custo_centavos)::text AS custo
        FROM midia_metrica_dia WHERE anuncio_id = ${ANUN_A} AND dia = ${dia}`)
    expect([r!.n, r!.custo]).toEqual([1, '2500'])
  })
})

describe('Código da sessão de LP (AQ-44/45)', () => {
  it('o código é único por tenant, mas convive entre tenants', async () => {
    await dono`INSERT INTO midia_sessao_lp (tenant_id, id, codigo, click_id)
               VALUES (${A}, gen_random_uuid(), 'A7K2Q', 'gclid-abc')`
    await dono`INSERT INTO midia_sessao_lp (tenant_id, id, codigo)
               VALUES (${B}, gen_random_uuid(), 'A7K2Q')`

    await expect(
      dono`INSERT INTO midia_sessao_lp (tenant_id, id, codigo)
           VALUES (${A}, gen_random_uuid(), 'A7K2Q')`,
    ).rejects.toThrow(/midia_sessao_codigo_unico/)
  })

  it('código fora do formato é recusado', async () => {
    await expect(
      dono`INSERT INTO midia_sessao_lp (tenant_id, id, codigo)
           VALUES (${A}, gen_random_uuid(), 'a7k2q-minusculo')`,
    ).rejects.toThrow(/midia_sessao_codigo_formato/)
  })
})
