import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'

/**
 * E5-13 no ENDPOINT — prova que o gateway está no caminho: um destino em
 * opt-out é recusado ANTES de qualquer rede (o gateway barra pré-despacho).
 *
 * ⚠️ Casa por `chave_bloqueio` (INV-50), não por e164: o opt-out precisa valer
 * com e sem o nono dígito. Por isso o telefone entra com uma chave e o bloqueio
 * é gravado com essa mesma chave.
 */
const T = 'e5130000-0000-4000-8000-000000000001'
const PV = 'e5130000-1111-4000-8000-000000000001'
const PLANO = 'e5130000-3333-4000-8000-000000000001'
const MODELO = 'e5130000-4444-4000-8000-000000000001'
const CANAL = 'e5130000-5555-4000-8000-000000000001'
const CONTATO = 'e5130000-6666-4000-8000-000000000001'
const CONVERSA = 'e5130000-7777-4000-8000-000000000001'
const E164 = '5581999990000'
const CHAVE = '5581999990000' // 55 + DDD + últimos 8 (aqui coincide)

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance

const enviar = (corpo: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/v1/conversas/${CONVERSA}/mensagens`, headers: { 'x-tenant-id': T }, payload: corpo })

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-e513', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-e513', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'Loja E513', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  // Canal não-oficial conectado, COM credencial (para provar que o bloqueio, e
  // não a falta de credencial, é o que barra).
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado, credenciais_cifradas)
             VALUES (${T}, ${CANAL}, 'whatsapp_nao_oficial', 'plugzapi', 'WA', 'conectado', '\\x00'::bytea) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES (${T}, ${CONTATO}, 'Cliente', 'teste', true) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, fonte)
             VALUES (${T}, ${CONTATO}, 1, ${E164}, ${CHAVE}, true, 'teste') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${T}, ${CONVERSA}, ${CANAL}, ${CONTATO}, 0) ON CONFLICT DO NOTHING`

  app = await criarApp()
  await app.ready()
})

afterAll(async () => {
  await dono`DELETE FROM mensagem WHERE tenant_id = ${T}`
  await dono`DELETE FROM outbox WHERE tenant_id = ${T}`
  await dono`DELETE FROM lista_bloqueio WHERE tenant_id = ${T}`
  await dono`DELETE FROM conversa WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato_telefone WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato WHERE tenant_id = ${T}`
  await dono`DELETE FROM canal_conectado WHERE tenant_id = ${T}`
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${T}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${T}`
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close()
  await encerrarBanco()
  await dono.end()
})

describe('E5-13: gateway aplicado no endpoint de envio', () => {
  it('⚠️ destino em opt-out é recusado com 409 bloqueado, sem despacho', async () => {
    await dono`DELETE FROM mensagem WHERE tenant_id = ${T}`
    await dono`INSERT INTO lista_bloqueio (tenant_id, chave_bloqueio, motivo, origem)
               VALUES (${T}, ${CHAVE}, 'opt_out', 'teste') ON CONFLICT DO NOTHING`

    const r = await enviar({ tipo: 'texto', texto: 'olá' })
    expect(r.statusCode).toBe(409)
    expect(r.json()).toMatchObject({ ok: false, motivo: 'bloqueado' })

    // A mensagem foi persistida (Fase 1) mas marcada 'falhou' — nunca 'enviada',
    // porque o adaptador não foi chamado.
    const [m] = await dono<{ status: string; id_externo: string | null }[]>`
      SELECT status, id_externo FROM mensagem WHERE tenant_id = ${T} AND direcao = 'saliente' ORDER BY criado_em DESC LIMIT 1`
    expect(m!.status).toBe('falhou')
    expect(m!.id_externo).toBeNull()
  })
})
