import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import {
  varrerSincronizacaoMidia, varrerConversoes,
  INTERVALO_SINCRONIZACAO_MS, INTERVALO_CONVERSOES_MS,
} from './worker.js'
import type { Sql } from '../../db/index.js'
import type { PortaPlataformaMidia } from './plataformas/porta.js'

const T = '000ce5a0-0000-4000-8000-000000000001'
const PV = '000ce5a0-1111-4000-8000-000000000001'
const PLANO = '000ce5a0-3333-4000-8000-000000000001'
const MODELO = '000ce5a0-4444-4000-8000-000000000001'
const CONTA = '000ce5a0-7777-4000-8000-000000000001'
const CONTA_MCC = '000ce5a0-7777-4000-8000-0000000000cc'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
const sql = dono as unknown as Sql
const AGORA = new Date('2026-08-23T12:00:00Z')

const ENV = {
  GOOGLE_ADS_DEVELOPER_TOKEN: 'dev',
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: '123-276-0756',
  GOOGLE_OAUTH_CLIENT_ID: 'cid',
  GOOGLE_OAUTH_CLIENT_SECRET: 'sec',
  GOOGLE_OAUTH_REFRESH_TOKEN: 'ref',
} as NodeJS.ProcessEnv

function falsa(): PortaPlataformaMidia & { contasVistas: string[] } {
  const p = {
    plataforma: 'google' as const,
    contasVistas: [] as string[],
    chamadas: 0,
    capacidades: {
      leituraEstrutura: true, leituraMetrica: true, publicoPersonalizado: false,
      conversaoOffline: false, cliqueParaConversa: false, escritaEstado: false, escritaOrcamento: false,
    },
    async testarConexao() { return { ok: true as const, dados: { nomeConta: 'x', moeda: 'BRL' } } },
    async lerEstrutura(conta: string) {
      p.contasVistas.push(conta); p.chamadas += 3
      return { ok: true as const, dados: { campanhas: [], conjuntos: [], anuncios: [] } }
    },
    async lerMetricas() { p.chamadas += 1; return { ok: true as const, dados: [] } },
    async enviarConversao() { return { ok: false as const, motivo: 'resposta_inesperada' as const } },
  }
  return p as unknown as PortaPlataformaMidia & { contasVistas: string[] }
}

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-teste-worker', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-teste-worker', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id)
             VALUES (${T}, 'Loja', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome)
             VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
})

beforeEach(async () => {
  await dono`DELETE FROM midia_conta WHERE tenant_id = ${T}`
})

afterAll(async () => {
  await dono`DELETE FROM midia_conta WHERE tenant_id = ${T}`
  await dono.end()
})

describe('A cota decide a cadência', () => {
  /**
   * ⚠️ Sincronizar de 30 em 30 min gastaria ~192 requisições por conta por dia
   * (~15 contas em 2.880) contra ~16 a cada 6h (~180 contas). Métrica do Google
   * fecha por DIA — a pressa não traria dado novo, só custaria clientes.
   */
  it('sincronização é MUITO mais folgada que conversões', () => {
    expect(INTERVALO_SINCRONIZACAO_MS).toBe(6 * 60 * 60 * 1000)
    expect(INTERVALO_CONVERSOES_MS).toBeLessThan(INTERVALO_SINCRONIZACAO_MS / 10)
  })
})

describe('Varredura de sincronização', () => {
  it('percorre as contas ativas e soma as requisições gastas', async () => {
    await dono`INSERT INTO midia_conta (tenant_id, id, plataforma, id_externo, nome)
               VALUES (${T}, ${CONTA}, 'google', '997-075-4431', 'Drezz')`
    const p = falsa()
    const r = await varrerSincronizacaoMidia(sql, { agora: AGORA, adaptadorPara: () => p, env: ENV })

    expect(r.contas).toBe(1)
    expect(r.chamadas).toBe(4)                        // 3 estrutura + 1 métrica
    expect(p.contasVistas).toEqual(['997-075-4431'])
  })

  /**
   * ⚠️ Achado da primeira chamada real: a MCC responde `customer` mas RECUSA
   * métrica (`REQUESTED_METRICS_FOR_MANAGER`) — ela só agrega. Cadastrada por
   * engano, gastaria cota toda passada para falhar. Pular é mais honesto que
   * tentar e registrar erro para sempre.
   */
  it('PULA a conta de gerenciador em vez de gastar cota falhando', async () => {
    await dono`INSERT INTO midia_conta (tenant_id, id, plataforma, id_externo, nome)
               VALUES (${T}, ${CONTA_MCC}, 'google', '123-276-0756', 'MCC por engano')`
    const p = falsa()
    const r = await varrerSincronizacaoMidia(sql, { agora: AGORA, adaptadorPara: () => p, env: ENV })

    expect(r.ignoradasPorSeremGerenciador).toBe(1)
    expect(r.contas).toBe(0)
    expect(p.contasVistas).toEqual([])   // ⚠️ nem chegou a chamar
    expect(r.chamadas).toBe(0)
  })

  it('conta inativa não é sincronizada', async () => {
    await dono`INSERT INTO midia_conta (tenant_id, id, plataforma, id_externo, nome, ativo)
               VALUES (${T}, ${CONTA}, 'google', '997-075-4431', 'Drezz', false)`
    const r = await varrerSincronizacaoMidia(sql, { agora: AGORA, adaptadorPara: () => falsa(), env: ENV })
    expect(r.contas).toBe(0)
  })

  it('sem contas, a passada é inócua', async () => {
    const r = await varrerSincronizacaoMidia(sql, { agora: AGORA, adaptadorPara: () => falsa(), env: ENV })
    expect(r).toMatchObject({ contas: 0, chamadas: 0 })
  })
})

describe('Varredura de conversões', () => {
  it('roda sem tenant com origem de mídia', async () => {
    const r = await varrerConversoes(sql, { agora: AGORA, adaptadorPara: () => falsa(), env: ENV })
    expect(r.despacho).toMatchObject({ enviadas: 0, falhadas: 0 })
  })
})
