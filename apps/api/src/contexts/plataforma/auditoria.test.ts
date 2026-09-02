import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'

/**
 * EP-07 — leitura do rastro de auditoria com paginação por CURSOR.
 *
 * ⚠️ O invariante do CLAUDE.md: lista sempre por cursor, nunca top-N cru. Os
 * riscos que o teste fecha:
 *   • a paginação não pode PERDER nem DUPLICAR linha entre páginas;
 *   • a última página zera `proximoCursor` (senão a tela pagina para sempre);
 *   • um tenant nunca lê o rastro de outro (RLS).
 */
const T = 'aad17000-0000-4000-8000-000000000001'
const OUTRO = 'aad17000-0000-4000-8000-000000000002'
const PV = 'aad17000-1111-4000-8000-000000000001'
const PV2 = 'aad17000-1111-4000-8000-000000000002'
const PLANO = 'aad17000-3333-4000-8000-000000000001'
const MODELO = 'aad17000-4444-4000-8000-000000000001'
const ATOR = 'aad17000-8888-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance

const chamar = (tenant: string, url: string) =>
  app.inject({ method: 'GET', url, headers: { 'x-tenant-id': tenant } })

// ⚠️ Início do MÊS CORRENTE: as partições da auditoria vão de `now()` a +12
//    meses (migration 0004). Uma data fixa no passado não tem partição — e o
//    INSERT falharia. 120 min a partir do dia 1º cabem no mês, sempre.
const agora = new Date()
const INICIO_MES = Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), 1)

/** Insere N entradas com `criado_em` crescente e determinístico. */
async function semear(tenant: string, n: number, base = INICIO_MES): Promise<void> {
  for (let i = 0; i < n; i++) {
    const quando = new Date(base + i * 60_000).toISOString()
    await dono`
      INSERT INTO auditoria (tenant_id, id, criado_em, ator_id, acao, entidade, entidade_id, dados)
      VALUES (${tenant}, ${randomUUID()}, ${quando}, ${ATOR}, 'atendimento.assumido', 'conversa',
              ${randomUUID()}, ${JSON.stringify({ protocolo: i })}::text::jsonb)`
  }
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-audit', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-audit', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'Loja A'], [OUTRO, PV2, 'Loja B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${T}, ${ATOR}, 'sub-audit', 'Ana', 'ana@t.local') ON CONFLICT (tenant_id, cognito_sub) DO NOTHING`
  app = await criarApp()
  await app.ready()
})

afterAll(async () => {
  for (const t of [T, OUTRO]) {
    await dono`DELETE FROM auditoria WHERE tenant_id = ${t}`
    await dono`DELETE FROM usuario WHERE tenant_id = ${t}`
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close()
  await encerrarBanco()
  await dono.end()
})

describe('EP-07: /v1/auditoria por cursor', () => {
  it('pagina 120 linhas sem perder nem duplicar, e a última página zera o cursor', async () => {
    await dono`DELETE FROM auditoria WHERE tenant_id = ${T}`
    await semear(T, 120) // 50 + 50 + 20 → 3 páginas (PAGINA = 50)

    const vistos: string[] = []
    let cursor: string | null = null
    let paginas = 0
    do {
      const url: string = cursor ? `/v1/auditoria?cursor=${encodeURIComponent(cursor)}` : '/v1/auditoria'
      const r = await chamar(T, url)
      expect(r.statusCode).toBe(200)
      const corpo = r.json() as { itens: { entidadeId: string }[]; proximoCursor: string | null }
      // Mais novo primeiro: dentro da página, criado_em decrescente.
      for (const it of corpo.itens) vistos.push(it.entidadeId)
      cursor = corpo.proximoCursor
      paginas++
      expect(paginas).toBeLessThanOrEqual(5) // trava de laço infinito
    } while (cursor)

    expect(paginas).toBe(3)
    expect(vistos.length).toBe(120)
    // Sem duplicar: todos os entidadeId são únicos.
    expect(new Set(vistos).size).toBe(120)
  })

  it('cursor inválido responde 422, não 500', async () => {
    const r = await chamar(T, '/v1/auditoria?cursor=lixo')
    expect(r.statusCode).toBe(422)
  })

  it('⚠️ isolamento: o rastro de um tenant nunca aparece para outro (RLS)', async () => {
    await dono`DELETE FROM auditoria WHERE tenant_id IN (${T}, ${OUTRO})`
    await semear(OUTRO, 3)
    const r = await chamar(T, '/v1/auditoria')
    const corpo = r.json() as { itens: unknown[] }
    expect(corpo.itens.length).toBe(0)
  })
})
