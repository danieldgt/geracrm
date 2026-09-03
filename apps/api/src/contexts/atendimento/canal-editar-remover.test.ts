import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'
import { decifrar } from '../integracao/cofre.js'

/**
 * Editar e remover número (0083).
 *
 * ⚠️ O buraco que isto fecha: cadastro errado era PERMANENTE. Um PlugZapi com a
 * URL do endpoint colada no campo do Client-Token ficava desconectado, sem rota
 * nem botão que corrigisse ou tirasse da frota.
 *
 * ⚠️ Fixtures exclusivas deste arquivo (a suíte roda em paralelo contra o mesmo
 * banco): tenant, plano e modelo têm nome próprio.
 */
const T = 'ce70a000-0000-4000-8000-000000000001'
const T2 = 'ce70a000-0000-4000-8000-000000000002'
const PV = 'ce70a000-1111-4000-8000-000000000001'
const PV2 = 'ce70a000-1111-4000-8000-000000000002'
const PLANO = 'ce70a000-3333-4000-8000-000000000001'
const MODELO = 'ce70a000-4444-4000-8000-000000000001'
const CONTATO = 'ce70a000-6666-4000-8000-000000000001'

const CRED = { instancia: 'INST-1', token: 'TOK-1', clientToken: 'CLIENT-1' }

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance

const chamar = (method: 'PUT' | 'DELETE' | 'GET', url: string, payload?: unknown, tenant = T) =>
  app.inject({ method, url, headers: { 'x-tenant-id': tenant }, ...(payload ? { payload } : {}) })

/** Cria um canal PlugZapi com credencial cifrada pela própria API (POST /v1/canais). */
async function criarCanal(nome: string, cred: Record<string, string> = CRED): Promise<string> {
  const r = await app.inject({
    method: 'POST', url: '/v1/canais', headers: { 'x-tenant-id': T },
    payload: { provedor: 'plugzapi', nomeAmigavel: nome, credencial: cred },
  })
  expect(r.statusCode).toBe(201)
  return (r.json() as { id: string }).id
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  process.env.CREDENCIAL_CHAVE ??= 'chave-de-teste-com-mais-de-32-caracteres-aqui'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-canal-editar', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-canal-editar', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [tenant, perfil, nome] of [[T, PV, 'Loja Editar'], [T2, PV2, 'Loja Vizinha']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id)
               VALUES (${tenant}, ${nome}, ${PLANO}, ${perfil}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome)
               VALUES (${tenant}, ${perfil}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await dono`INSERT INTO contato (tenant_id, id, nome) VALUES (${T}, ${CONTATO}, 'Cliente') ON CONFLICT DO NOTHING`
  app = await criarApp(); await app.ready()
})

beforeEach(async () => {
  await dono`DELETE FROM conversa WHERE tenant_id IN (${T}, ${T2})`
  await dono`DELETE FROM canal_conectado WHERE tenant_id IN (${T}, ${T2})`
})

afterAll(async () => {
  await dono`DELETE FROM auditoria WHERE tenant_id IN (${T}, ${T2})`
  await dono`DELETE FROM conversa WHERE tenant_id IN (${T}, ${T2})`
  await dono`DELETE FROM canal_conectado WHERE tenant_id IN (${T}, ${T2})`
  await dono`DELETE FROM contato WHERE tenant_id = ${T}`
  await dono`DELETE FROM usuario WHERE tenant_id IN (${T}, ${T2})`
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id IN (${T}, ${T2})`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id IN (${T}, ${T2})`
  await dono`DELETE FROM tenant WHERE id IN (${T}, ${T2})`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

async function credencialDe(id: string): Promise<Record<string, string>> {
  const [l] = await dono<{ credenciais_cifradas: Buffer }[]>`
    SELECT credenciais_cifradas FROM canal_conectado WHERE id = ${id}`
  return decifrar(l!.credenciais_cifradas) as Record<string, string>
}

describe('Editar número', () => {
  it('dado um campo de credencial errado, quando corrijo só ele, então os outros são mantidos', async () => {
    // O caso real: Client-Token com a URL do endpoint no lugar do token.
    const id = await criarCanal('Wpp errado', { ...CRED, clientToken: 'https://api.plugzapi.com.br/instances/x/token/y/send-text' })

    const r = await chamar('PUT', `/v1/canais/${id}`, { credencial: { clientToken: 'CLIENT-CERTO' } })

    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ ok: true, credencialTrocada: true })
    expect(await credencialDe(id)).toEqual({ ...CRED, clientToken: 'CLIENT-CERTO' })
  })

  it('dado que troquei a credencial, então o canal volta a "conectando" e perde o carimbo', async () => {
    const id = await criarCanal('Wpp')
    await dono`UPDATE canal_conectado SET estado = 'conectado', verificado_em = now(), ultimo_erro = 'antigo'
                WHERE id = ${id}`

    await chamar('PUT', `/v1/canais/${id}`, { credencial: { token: 'TOK-2' } })

    const [l] = await dono<{ estado: string; verificado_em: Date | null; ultimo_erro: string | null }[]>`
      SELECT estado, verificado_em, ultimo_erro FROM canal_conectado WHERE id = ${id}`
    // ⚠️ Credencial nova que ninguém testou não pode continuar dizendo "conectado".
    expect(l).toMatchObject({ estado: 'conectando', verificado_em: null, ultimo_erro: null })
  })

  it('dado só a troca de nome, quando salvo, então a credencial fica intacta', async () => {
    const id = await criarCanal('Nome velho')

    const r = await chamar('PUT', `/v1/canais/${id}`, { nomeAmigavel: 'Nome novo' })

    expect(r.json()).toMatchObject({ ok: true, credencialTrocada: false })
    expect(await credencialDe(id)).toEqual(CRED)
    const [l] = await dono<{ nome_amigavel: string }[]>`SELECT nome_amigavel FROM canal_conectado WHERE id = ${id}`
    expect(l?.nome_amigavel).toBe('Nome novo')
  })

  it('dado nome em branco, quando salvo, então recusa nomeando o campo', async () => {
    const id = await criarCanal('Wpp')
    const r = await chamar('PUT', `/v1/canais/${id}`, { nomeAmigavel: '   ' })
    expect(r.statusCode).toBe(422)
    expect(r.json()).toMatchObject({ erro: 'canal.nome_obrigatorio', detalhe: { campo: 'nomeAmigavel' } })
  })

  it('dado nada informado, quando salvo, então diz que não há o que mudar', async () => {
    const id = await criarCanal('Wpp')
    const r = await chamar('PUT', `/v1/canais/${id}`, {})
    expect(r.statusCode).toBe(422)
    expect(r.json()).toMatchObject({ erro: 'canal.nada_para_mudar' })
  })

  it('dado canal de outro tenant, quando tento editar, então não encontro (RLS)', async () => {
    const id = await criarCanal('Wpp do vizinho')
    const r = await chamar('PUT', `/v1/canais/${id}`, { nomeAmigavel: 'invadido' }, T2)
    expect(r.statusCode).toBe(404)
    expect(await credencialDe(id)).toEqual(CRED)
  })
})

describe('Remover número', () => {
  it('dado canal que nunca conversou, quando removo, então é apagado de fato', async () => {
    const id = await criarCanal('Nunca usado')

    const r = await chamar('DELETE', `/v1/canais/${id}`)

    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ ok: true, estado: 'removido' })
    const linhas = await dono`SELECT 1 FROM canal_conectado WHERE id = ${id}`
    expect(linhas).toHaveLength(0)
  })

  it('dado canal com conversa, quando removo, então ARQUIVA e a conversa continua lá', async () => {
    const id = await criarCanal('Já conversou')
    const conversaId = randomUUID()
    await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao)
               VALUES (${T}, ${conversaId}, ${id}, ${CONTATO}, 0)`

    const r = await chamar('DELETE', `/v1/canais/${id}`)

    expect(r.json()).toMatchObject({ ok: true, estado: 'arquivado', conversas: 1 })
    const [canal] = await dono<{ arquivado_em: Date | null }[]>`
      SELECT arquivado_em FROM canal_conectado WHERE id = ${id}`
    expect(canal?.arquivado_em).toBeInstanceOf(Date)
    // ⚠️ O histórico é a razão de arquivar em vez de apagar.
    const conversas = await dono`SELECT 1 FROM conversa WHERE id = ${conversaId}`
    expect(conversas).toHaveLength(1)
  })

  it('dado canal arquivado, então some da lista e não é mais encontrado', async () => {
    const id = await criarCanal('Some daqui')
    await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao)
               VALUES (${T}, ${randomUUID()}, ${id}, ${CONTATO}, 0)`
    await chamar('DELETE', `/v1/canais/${id}`)

    const lista = await chamar('GET', '/v1/canais')
    const itens = (lista.json() as { itens: { id: string }[] }).itens
    expect(itens.find((c) => c.id === id)).toBeUndefined()

    // Nem edição, nem remoção de novo: para a operação, ele não existe mais.
    expect((await chamar('PUT', `/v1/canais/${id}`, { nomeAmigavel: 'x' })).statusCode).toBe(404)
    expect((await chamar('DELETE', `/v1/canais/${id}`)).statusCode).toBe(404)
  })

  it('dado canal de outro tenant, quando tento remover, então não encontro (RLS)', async () => {
    const id = await criarCanal('Wpp do vizinho')
    const r = await chamar('DELETE', `/v1/canais/${id}`, undefined, T2)
    expect(r.statusCode).toBe(404)
    const linhas = await dono`SELECT 1 FROM canal_conectado WHERE id = ${id}`
    expect(linhas).toHaveLength(1)
  })

  it('dado que removi, então a auditoria registra a ação sem nenhum valor de credencial', async () => {
    const id = await criarCanal('Auditado')
    await chamar('DELETE', `/v1/canais/${id}`)

    const [reg] = await dono<{ acao: string; dados: Record<string, unknown> }[]>`
      SELECT acao, dados FROM auditoria
       WHERE tenant_id = ${T} AND entidade = 'canal_conectado' AND entidade_id = ${id}`
    expect(reg?.acao).toBe('canal.removido')
    expect(JSON.stringify(reg?.dados)).not.toContain(CRED.token)
  })
})
