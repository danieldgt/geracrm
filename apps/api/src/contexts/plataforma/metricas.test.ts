import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { avaliarEntrega, registrarMetrica, avaliarEAlertarEntrega, REGRA_ENTREGA } from './metricas.js'

/**
 * I-11 (série temporal) + I-10 (alertas). A regra pura fixa QUANDO alerta; o
 * resto prova agregação por hora, dedup do alerta e a resolução quando melhora.
 */
describe('avaliarEntrega: a regra pura', () => {
  it('sem massa mínima, nunca alerta (1 falha em 2 é acaso)', () => {
    expect(avaliarEntrega({ ok: 1, falha: 1 }).alerta).toBe(false)
  })
  it('com volume e taxa baixa, alerta', () => {
    const r = avaliarEntrega({ ok: 5, falha: 20 }) // 20% de sucesso, 25 amostras
    expect(r.alerta).toBe(true)
    expect(r.amostras).toBe(25)
    expect(r.taxa).toBeCloseTo(0.2, 5)
  })
  it('com volume e taxa saudável, não alerta', () => {
    expect(avaliarEntrega({ ok: 95, falha: 5 }).alerta).toBe(false)
  })
  it('exatamente no limiar de amostras mas taxa boa → não alerta', () => {
    expect(avaliarEntrega({ ok: REGRA_ENTREGA.minAmostras, falha: 0 }).alerta).toBe(false)
  })
})

const T = 'a10a0000-0000-4000-8000-000000000001'
const OUTRO = 'a10a0000-0000-4000-8000-000000000002'
const PV = 'a10a0000-1111-4000-8000-000000000001'
const PV2 = 'a10a0000-1111-4000-8000-000000000002'
const PLANO = 'a10a0000-3333-4000-8000-000000000001'
const MODELO = 'a10a0000-4444-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const api = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => {} })

async function comoTenant<X>(t: string, fn: (tx: postgres.Sql) => Promise<X>): Promise<X> {
  return api.begin(async (tx) => {
    await tx`SELECT set_config('geracrm.tenant_id', ${t}, true)`
    return fn(tx as unknown as postgres.Sql)
  }) as Promise<X>
}

const AGORA = new Date('2026-08-09T12:30:00Z')
const alertasAbertos = (t: string) => comoTenant(t, (tx) => tx<{ n: number }[]>`
  SELECT count(*)::int AS n FROM alerta WHERE tenant_id = tenant_atual() AND tipo = 'entrega_baixa' AND resolvido_em IS NULL`)
  .then((r) => r[0]!.n)

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-i10', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-i10', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'Loja A'], [OUTRO, PV2, 'Loja B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
})

afterAll(async () => {
  for (const t of [T, OUTRO]) {
    await dono`DELETE FROM alerta WHERE tenant_id = ${t}`
    await dono`DELETE FROM metrica_janela WHERE tenant_id = ${t}`
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await dono.end(); await api.end()
})

describe('agregação + alerta ponta a ponta', () => {
  it('incrementa o balde da hora (mesma hora soma, não duplica linha)', async () => {
    await dono`DELETE FROM metrica_janela WHERE tenant_id = ${T}`
    await comoTenant(T, async (tx) => {
      await registrarMetrica(tx, 'envio_ok', 1, AGORA)
      await registrarMetrica(tx, 'envio_ok', 1, new Date('2026-08-09T12:59:00Z')) // mesma hora
    })
    const linhas = await dono<{ valor: string }[]>`SELECT valor::text FROM metrica_janela WHERE tenant_id = ${T} AND metrica = 'envio_ok'`
    expect(linhas.length).toBe(1)
    expect(Number(linhas[0]!.valor)).toBe(2)
  })

  it('⚠️ queda de entrega sobe UM alerta; reentrada de avaliação não duplica', async () => {
    await dono`DELETE FROM metrica_janela WHERE tenant_id = ${T}`
    await dono`DELETE FROM alerta WHERE tenant_id = ${T}`
    await comoTenant(T, async (tx) => {
      await registrarMetrica(tx, 'envio_ok', 5, AGORA)
      await registrarMetrica(tx, 'envio_falha', 20, AGORA)
      await avaliarEAlertarEntrega(tx, AGORA)
      await avaliarEAlertarEntrega(tx, AGORA) // reavaliação no mesmo estado
    })
    expect(await alertasAbertos(T)).toBe(1)
  })

  it('⚠️ quando a entrega volta ao normal, o alerta aberto é RESOLVIDO', async () => {
    await dono`DELETE FROM metrica_janela WHERE tenant_id = ${T}`
    await dono`DELETE FROM alerta WHERE tenant_id = ${T}`
    // 1) cai → alerta
    await comoTenant(T, async (tx) => {
      await registrarMetrica(tx, 'envio_falha', 20, AGORA)
      await avaliarEAlertarEntrega(tx, AGORA)
    })
    expect(await alertasAbertos(T)).toBe(1)
    // 2) melhora → resolve
    await comoTenant(T, async (tx) => {
      await registrarMetrica(tx, 'envio_ok', 200, AGORA)
      await avaliarEAlertarEntrega(tx, AGORA)
    })
    expect(await alertasAbertos(T)).toBe(0)
  })

  it('⚠️ isolamento: métrica/alerta de um tenant não vaza para outro (RLS)', async () => {
    await dono`DELETE FROM metrica_janela WHERE tenant_id IN (${T}, ${OUTRO})`
    await comoTenant(T, (tx) => registrarMetrica(tx, 'envio_ok', 7, AGORA))
    const doOutro = await comoTenant(OUTRO, (tx) => tx`SELECT * FROM metrica_janela WHERE metrica = 'envio_ok'`)
    expect(doOutro.length).toBe(0)
  })
})
