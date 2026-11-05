import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../../app.js'
import { encerrarBanco } from '../../../db/index.js'

/**
 * `GET/PUT /v1/canais/:id/agente/agenda` (C3): 404 com o módulo desligado, padrão desligado, e
 * (revisão B4) template só APROVADO e compatível (no máximo {{1}}), 422 por campo. Prefixo c3e1.
 */
const A = 'c3e10000-0000-4000-8000-00000000000a'
const B = 'c3e10000-0000-4000-8000-00000000000b'
const PLANO = 'c3e10000-0001-4000-8000-000000000001'
const MODELO = 'c3e10000-0002-4000-8000-000000000001'
const PV: Record<string, string> = { [A]: 'c3e10000-0003-4000-8000-00000000000a', [B]: 'c3e10000-0003-4000-8000-00000000000b' }
const CANAL = { [A]: 'c3e10000-0004-4000-8000-00000000000a', [B]: 'c3e10000-0004-4000-8000-00000000000b' } as Record<string, string>
const OK = 'c3e10000-0005-4000-8000-000000000001'
const PENDENTE = 'c3e10000-0005-4000-8000-000000000002'
const DUAS_VARS = 'c3e10000-0005-4000-8000-000000000003'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const chamar = (t: string, method: 'GET' | 'PUT', corpo?: Record<string, unknown>) =>
  app.inject({ method, url: `/v1/canais/${CANAL[t]}/agente/agenda`, headers: { 'x-tenant-id': t }, ...(corpo ? { payload: corpo } : {}) })
const corpo = (extra: Record<string, unknown> = {}) => ({ reunioes: true, templateLembreteId: null, templateReagendarId: null, ...extra })

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-c3e1', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-c3e1', 'Varejo') ON CONFLICT DO NOTHING`
  for (const t of [A, B]) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${'Chave ' + t.slice(-1)}, ${PLANO}, ${PV[t]!}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${PV[t]!}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
    await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES (${t}, ${CANAL[t]!}, 'whatsapp_oficial', 'Oficial', 'conectado')`
  }
  await dono`INSERT INTO tenant_modulo (tenant_id, modulo, ativo) VALUES (${A}, 'agenda', true) ON CONFLICT (tenant_id, modulo) DO UPDATE SET ativo = true`
  for (const [id, status, texto] of [[OK, 'APPROVED', 'Olá {{1}}, lembrete da reunião.'], [PENDENTE, 'PENDING', 'Olá {{1}}.'], [DUAS_VARS, 'APPROVED', 'Olá {{1}}, às {{2}}.']] as const) {
    await dono`INSERT INTO template (tenant_id, id, nome, categoria) VALUES (${A}, ${id}, ${'tpl-' + id.slice(-1)}, 'UTILITY')`
    await dono`INSERT INTO template_versao (tenant_id, template_id, versao, corpo, status_meta)
               VALUES (${A}, ${id}, 1, ${JSON.stringify({ body: { texto } })}::text::jsonb, ${status})`
  }
  app = await criarApp(); await app.ready()
})

afterAll(async () => {
  for (const t of [A, B]) {
    for (const tab of ['auditoria', 'agente_config', 'template_versao', 'template', 'canal_conectado', 'tenant_modulo', 'usuario']) {
      await dono.unsafe(`DELETE FROM ${tab} WHERE tenant_id = '${t}'`)
    }
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('Chave "O agente pode marcar reuniões"', () => {
  it('módulo desligado → 404 nas duas rotas', async () => {
    expect((await chamar(B, 'GET')).statusCode).toBe(404)
    expect((await chamar(B, 'PUT', corpo())).statusCode).toBe(404)
  })

  it('nasce desligada; liga e grava', async () => {
    expect((await chamar(A, 'GET')).json()).toMatchObject({ reunioes: false, templateLembreteId: null, modoDoNumero: 'desligado' })
    expect((await chamar(A, 'PUT', corpo({ templateLembreteId: OK }))).statusCode).toBe(200)
    expect((await chamar(A, 'GET')).json()).toMatchObject({ reunioes: true, templateLembreteId: OK })
  })

  it('⚠️ B4: template não aprovado ou com variável além do {{1}} → 422 no campo', async () => {
    const p = await chamar(A, 'PUT', corpo({ templateLembreteId: PENDENTE }))
    expect(p.statusCode).toBe(422)
    expect(p.json()).toMatchObject({ erro: 'agenda.template_invalido', campos: { templateLembreteId: expect.stringMatching(/aprovado/) } })
    const d = await chamar(A, 'PUT', corpo({ templateReagendarId: DUAS_VARS }))
    expect(d.statusCode).toBe(422)
    expect(d.json()).toMatchObject({ campos: { templateReagendarId: expect.stringMatching(/primeiro nome/) } })
    expect((await chamar(A, 'PUT', corpo({ templateReagendarId: 'c3e10000-0005-4000-8000-000000000009' }))).statusCode).toBe(422)
  })
})
