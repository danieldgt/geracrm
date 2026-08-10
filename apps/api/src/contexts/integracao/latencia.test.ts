import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { medirLatencia, latenciaMedia } from './latencia.js'

/**
 * Onda 2 — medição de latência do conector. Fixa: soma+contagem por balde
 * compõem a média sem perder agregação; a leitura junta por (conector, chamada).
 */
const T = 'ade00000-0000-4000-8000-000000000001'
const PV = 'ade00000-1111-4000-8000-000000000001'
const PLANO = 'ade00000-3333-4000-8000-000000000001'
const MODELO = 'ade00000-4444-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const api = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => {} })
const comoT = <X>(fn: (tx: postgres.Sql) => Promise<X>) => api.begin(async (tx) => {
  await tx`SELECT set_config('geracrm.tenant_id', ${T}, true)`
  return fn(tx as unknown as postgres.Sql)
}) as Promise<X>
const AGORA = new Date('2026-08-10T12:00:00Z')

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-lat', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-lat', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'Loja Lat', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
})
beforeEach(async () => { await dono`DELETE FROM metrica_janela WHERE tenant_id = ${T}` })
afterAll(async () => {
  await dono`DELETE FROM metrica_janela WHERE tenant_id = ${T}`
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${T}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${T}`
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await dono.end(); await api.end()
})

describe('Onda 2: latência do conector', () => {
  it('mede a chamada e devolve o resultado dela intacto', async () => {
    const r = await comoT((tx) => medirLatencia(tx, 'geracloud', 'testar', AGORA, async () => 'ok'))
    expect(r).toBe('ok')
    const [soma] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM metrica_janela WHERE tenant_id = ${T} AND metrica LIKE 'lat_%'`
    expect(soma!.n).toBe(2) // lat_soma + lat_n
  })

  it('⚠️ mede mesmo quando a chamada FALHA (finally) — e propaga o erro', async () => {
    let lancou = false
    await comoT(async (tx) => {
      try { await medirLatencia(tx, 'geracloud', 'testar', AGORA, async () => { throw new Error('caiu') }) }
      catch { lancou = true } // captura DENTRO da tx para ela commitar o metric
    })
    expect(lancou).toBe(true) // o erro foi propagado
    const [n] = await dono<{ v: string }[]>`SELECT valor::text AS v FROM metrica_janela WHERE tenant_id = ${T} AND metrica = 'lat_n:geracloud:testar'`
    expect(Number(n!.v)).toBe(1) // contou a tentativa que falhou (finally)
  })

  it('média = soma/contagem por (conector, chamada)', async () => {
    // Injeta 3 amostras somando 300ms → média 100ms.
    await comoT(async (tx) => {
      for (const ms of [50, 100, 150]) {
        await tx`INSERT INTO metrica_janela (tenant_id, metrica, bucket, valor)
                 VALUES (tenant_atual(), 'lat_soma:geracloud:testar', date_trunc('hour', now()), ${ms})
                 ON CONFLICT (tenant_id, metrica, bucket) DO UPDATE SET valor = metrica_janela.valor + ${ms}`
        await tx`INSERT INTO metrica_janela (tenant_id, metrica, bucket, valor)
                 VALUES (tenant_atual(), 'lat_n:geracloud:testar', date_trunc('hour', now()), 1)
                 ON CONFLICT (tenant_id, metrica, bucket) DO UPDATE SET valor = metrica_janela.valor + 1`
      }
    })
    const linhas = await comoT((tx) => latenciaMedia(tx))
    const gc = linhas.find((l) => l.conector === 'geracloud' && l.chamada === 'testar')
    expect(gc).toMatchObject({ mediaMs: 100, amostras: 3 })
  })
})
