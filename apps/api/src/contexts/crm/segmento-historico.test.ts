import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'
import { capturarSegmentosTenant } from './segmento-historico.js'
import type { Sql } from '../../db/index.js'

/** Trajetória de segmento RFV: grava SÓ na transição; a ficha lê o histórico. */
const T = 'e5e70000-0000-4000-8000-000000000001'
const PV = 'e5e70000-1111-4000-8000-000000000001'
const PLANO = 'e5e70000-3333-4000-8000-000000000001'
const MODELO = 'e5e70000-4444-4000-8000-000000000001'
const C = 'e5e70000-6666-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const sql = dono as unknown as Sql
let app: FastifyInstance

const vendaHa = (dias: number) =>
  dono`INSERT INTO venda (tenant_id, id, contato_id, ocorrida_em, valor_centavos)
       VALUES (${T}, ${randomUUID()}, ${C}, now() - (${dias} || ' days')::interval, 30000)`
const refresh = () => dono`SELECT atualizar_metricas_contato()`

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-sh', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-sh', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'Loja SH', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES (${T}, ${C}, 'Trajetória', 'teste', true) ON CONFLICT DO NOTHING`
  app = await criarApp(); await app.ready()
})

afterAll(async () => {
  await dono`DELETE FROM contato_segmento_historico WHERE tenant_id = ${T}`
  await dono`DELETE FROM venda WHERE tenant_id = ${T}`
  await refresh()
  await dono`DELETE FROM contato WHERE tenant_id = ${T}`
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${T}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${T}`
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('Histórico de segmento RFV', () => {
  it('grava só na TRANSIÇÃO; passada sem mudança não repete; a ficha lê a trajetória', async () => {
    // Round 1: 1 compra recente → "cliente-recente" (sem ritmo ainda).
    await vendaHa(5); await refresh()
    expect(await capturarSegmentosTenant(sql, T)).toBe(1)
    // Passada de novo, sem mudança → não repete.
    expect(await capturarSegmentosTenant(sql, T)).toBe(0)

    // Round 2: mais 2 compras antigas → agora tem ritmo com atraso baixo → "cliente-fiel".
    await vendaHa(60); await vendaHa(90); await refresh()
    expect(await capturarSegmentosTenant(sql, T)).toBe(1) // transição

    const hist = await dono<{ segmento: string }[]>`
      SELECT segmento FROM contato_segmento_historico
       WHERE tenant_id = ${T} AND contato_id = ${C} ORDER BY capturado_em ASC`
    expect(hist.map((h) => h.segmento)).toEqual(['cliente-recente', 'cliente-fiel'])

    // Endpoint devolve a trajetória (mais recente primeiro).
    const r = await app.inject({ method: 'GET', url: `/v1/contatos/${C}/segmento/historico`, headers: { 'x-tenant-id': T } })
    expect(r.statusCode).toBe(200)
    const itens = (r.json() as { itens: { segmento: string }[] }).itens
    expect(itens.map((i) => i.segmento)).toEqual(['cliente-fiel', 'cliente-recente'])
  })
})
