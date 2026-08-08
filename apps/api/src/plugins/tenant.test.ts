import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { criarApp } from '../app.js'
import { sql, encerrarBanco } from '../db/index.js'
import postgres from 'postgres'

// ⚠️ Preparo de dados usa conexão de DONO; a API usa geracrm_api, sem superusuário.
// Se os dois fossem o mesmo, o teste de isolamento passaria sem provar nada.
const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

/**
 * Isolamento por tenant, pela porta HTTP.
 *
 * ⚠️ Este teste vale mais que o de repositório: ele exercita o caminho real —
 * plugin, transação, SET LOCAL e RLS juntos. Um teste que chama o repositório
 * direto não pega o vazamento entre requisições que compartilham conexão.
 */

const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'
const PLANO = '33333333-3333-3333-3333-333333333333'
const MODELO = '44444444-4444-4444-4444-444444444444'

let app: FastifyInstance

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'

  await dono`INSERT INTO plano (id, codigo, nome, modulos)
            VALUES (${PLANO}, 'plano-teste-tenant', 'Pro', ARRAY['crm','campanha'])
            ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome)
            VALUES (${MODELO}, 'modelo-teste-tenant', 'Moda Atacado')
            ON CONFLICT DO NOTHING`

  for (const [id, nome, perfil] of [
    [A, 'Marca A', 'aaaaaaaa-0000-0000-0000-000000000001'],
    [B, 'Marca B', 'bbbbbbbb-0000-0000-0000-000000000001'],
  ] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id)
               VALUES (${id}, ${nome}, ${PLANO}, ${perfil})
               ON CONFLICT (id) DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome)
               VALUES (${id}, ${perfil}, ${MODELO}, 'Moda Atacado')
               ON CONFLICT DO NOTHING`
    })
  }

  app = await criarApp()
  await app.ready()
})

afterAll(async () => {
  await app?.close()
  // ⚠️ A FK entre tenant e perfil_vertical é circular. Apagar exige soltar a
  // ponta primeiro — o mesmo cuidado que a migration 0003 tem para criar.
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id IN (${A}, ${B})`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id IN (${A}, ${B})`
  await dono`DELETE FROM tenant WHERE id IN (${A}, ${B})`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await dono.end()
  await encerrarBanco()
})

const pedir = (tenant?: string) =>
  app.inject({ method: 'GET', url: '/v1/eu', headers: tenant ? { 'x-tenant-id': tenant } : {} })

describe('Saúde da API', () => {
  it('dado o serviço no ar, então /saude responde sem tocar o banco', async () => {
    const r = await app.inject({ method: 'GET', url: '/saude' })
    expect(r.statusCode).toBe(200)
    expect(r.json().ok).toBe(true)
  })

  it('dado banco acessível, então /pronto confirma', async () => {
    const r = await app.inject({ method: 'GET', url: '/pronto' })
    expect(r.statusCode).toBe(200)
    expect(r.json().banco).toBe('ok')
  })
})

describe('Isolamento por tenant, pela porta HTTP', () => {
  it('dado o tenant A, quando consulta, então enxerga apenas os dados dele', async () => {
    const r = await pedir(A)
    expect(r.statusCode).toBe(200)
    expect(r.json().tenant.nome).toBe('Marca A')
  })

  it('dado o tenant B, quando consulta, então enxerga apenas os dados dele', async () => {
    const r = await pedir(B)
    expect(r.json().tenant.nome).toBe('Marca B')
  })

  // ⚠️ O teste central. A consulta em /v1/eu não tem WHERE tenant_id nenhum —
  // quem separa é o RLS. Se o SET LOCAL vazasse entre requisições, alguma
  // destas leituras traria o nome errado.
  it('dadas requisições alternadas de A e B na mesma instância, então nenhuma enxerga a outra', async () => {
    const esperado = [A, B, A, A, B, B, A, B]
    const nomes = await Promise.all(esperado.map((t) => pedir(t).then((r) => r.json().tenant.nome)))
    expect(nomes).toEqual(esperado.map((t) => (t === A ? 'Marca A' : 'Marca B')))
  })

  it('dado nenhum tenant, quando consulta rota autenticada, então recusa com 401', async () => {
    const r = await pedir()
    expect(r.statusCode).toBe(401)
    expect(r.json().erro).toBe('autenticacao.ausente')
  })

  it('dado tenant inexistente, então a resposta é vazia — nunca dado de outro', async () => {
    const r = await pedir('99999999-9999-9999-9999-999999999999')
    expect(r.statusCode).toBe(200)
    expect(r.json().tenant).toBeNull()
  })

  it('dado header malformado, então é ignorado e a rota recusa', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/eu', headers: { 'x-tenant-id': 'nao-e-uuid' } })
    expect(r.statusCode).toBe(401)
  })
})
