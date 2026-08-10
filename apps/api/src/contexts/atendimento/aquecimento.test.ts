import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { limiteDiario, statusAquecimento } from './aquecimento.js'

/**
 * Onda 3 — aquecimento de frota. Fixa: a rampa cresce e tem teto; o status conta
 * o disparo de hoje e devolve o restante; sem registro → sem teto.
 */
describe('limiteDiario (rampa pura)', () => {
  it('começa baixo, cresce e satura no teto', () => {
    expect(limiteDiario(0)).toBe(20)
    expect(limiteDiario(1)).toBe(32)
    expect(limiteDiario(2)).toBe(51)
    expect(limiteDiario(30)).toBe(1000) // teto
    expect(limiteDiario(0)).toBeLessThan(limiteDiario(3))
  })
})

const T = 'aa3f0000-0000-4000-8000-000000000001'
const PV = 'aa3f0000-1111-4000-8000-000000000001'
const PLANO = 'aa3f0000-3333-4000-8000-000000000001'
const MODELO = 'aa3f0000-4444-4000-8000-000000000001'
const CANAL = 'aa3f0000-5555-4000-8000-000000000001'
const CONTATO = 'aa3f0000-6666-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const api = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => {} })
const comoT = <X>(fn: (tx: postgres.Sql) => Promise<X>) => api.begin(async (tx) => {
  await tx`SELECT set_config('geracrm.tenant_id', ${T}, true)`
  return fn(tx as unknown as postgres.Sql)
}) as Promise<X>

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-aq', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-aq', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'Loja Aq', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado) VALUES (${T}, ${CANAL}, 'whatsapp_nao_oficial', 'plugzapi', 'WA', 'conectado') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES (${T}, ${CONTATO}, 'C', 'teste', true) ON CONFLICT DO NOTHING`
})

beforeEach(async () => {
  await dono`DELETE FROM campanha_envio WHERE tenant_id = ${T}`
  await dono`DELETE FROM campanha WHERE tenant_id = ${T}`
  await dono`DELETE FROM canal_aquecimento WHERE tenant_id = ${T}`
})

afterAll(async () => {
  await dono`DELETE FROM campanha_envio WHERE tenant_id = ${T}`
  await dono`DELETE FROM campanha WHERE tenant_id = ${T}`
  await dono`DELETE FROM canal_aquecimento WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato WHERE tenant_id = ${T}`
  await dono`DELETE FROM canal_conectado WHERE tenant_id = ${T}`
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${T}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${T}`
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await dono.end(); await api.end()
})

describe('statusAquecimento', () => {
  it('sem registro de aquecimento → sem teto', async () => {
    const s = await comoT((tx) => statusAquecimento(tx, CANAL, new Date()))
    expect(s.emAquecimento).toBe(false)
    expect(s.limiteHoje).toBe(Infinity)
  })

  it('⚠️ dia 0: teto 20, conta o disparo de hoje e devolve o restante', async () => {
    await dono`INSERT INTO canal_aquecimento (tenant_id, canal_id, iniciado_em) VALUES (${T}, ${CANAL}, now())`
    // Uma campanha por este canal com 3 envios ENVIADOS hoje.
    const camp = randomUUID()
    await dono`INSERT INTO campanha (tenant_id, id, nome, canal_id, mensagem, estado, disparada_em) VALUES (${T}, ${camp}, 'C', ${CANAL}, 'oi', 'disparando', now())`
    // 3 destinatários distintos (o índice único é por campanha+contato).
    for (let i = 0; i < 3; i++) {
      const c = randomUUID()
      await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES (${T}, ${c}, ${'C' + i}, 'teste', true)`
      await dono`INSERT INTO campanha_envio (tenant_id, id, campanha_id, contato_id, estado, enviado_em) VALUES (${T}, ${randomUUID()}, ${camp}, ${c}, 'enviado', now())`
    }
    const s = await comoT((tx) => statusAquecimento(tx, CANAL, new Date()))
    expect(s).toMatchObject({ emAquecimento: true, dia: 0, limiteHoje: 20, usadoHoje: 3, restante: 17 })
  })

  it('dia 5: teto maior que no dia 0', async () => {
    await dono`INSERT INTO canal_aquecimento (tenant_id, canal_id, iniciado_em) VALUES (${T}, ${CANAL}, now() - interval '5 days')`
    const s = await comoT((tx) => statusAquecimento(tx, CANAL, new Date()))
    expect(s.dia).toBe(5)
    expect(s.limiteHoje).toBe(limiteDiario(5))
    expect(s.limiteHoje).toBeGreaterThan(20)
  })
})
