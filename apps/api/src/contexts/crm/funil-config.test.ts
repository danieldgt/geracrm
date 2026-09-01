import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'
import { MODELOS_FUNIL } from './funil-modelos.js'

/**
 * Funil configurável: bootstrap para tenant novo (o buraco que deixava o kanban
 * sem colunas e `POST /oportunidades` em 500) + CRUD de etapas e motivos.
 *
 * ⚠️ Os tenants deste arquivo nascem SEM etapa nenhuma de propósito — é o estado
 * de um cliente cadastrado depois da migration 0034, que é o caso sob teste.
 */
const T = 'fc9a0000-0000-4000-8000-000000000001'
const OUTRO = 'fc9a0000-0000-4000-8000-000000000002'
const PV = 'fc9a0000-1111-4000-8000-000000000001'
const PV2 = 'fc9a0000-1111-4000-8000-000000000002'
const PLANO = 'fc9a0000-3333-4000-8000-000000000001'
const MODELO = 'fc9a0000-4444-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance

const chamar = (t: string, m: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, corpo?: Record<string, unknown>) =>
  app.inject({ method: m, url, headers: { 'x-tenant-id': t }, ...(corpo ? { payload: corpo } : {}) })

interface EtapaCfg { id: string; chave: string; nome: string; tipo: string; ordem: number; ativo: boolean; total: number }
const etapasCfg = async (t: string): Promise<EtapaCfg[]> =>
  (await chamar(t, 'GET', '/v1/funil/config/etapas')).json<{ itens: EtapaCfg[] }>().itens

const novoContato = async (t: string) => {
  const id = randomUUID()
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES (${t}, ${id}, 'Confecção Teste', 'teste', true)`
  return id
}

const limparFunil = async () => {
  await dono`DELETE FROM oportunidade_etapa_historico WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM oportunidade WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM contato WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM funil_etapa WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM motivo_perda WHERE tenant_id IN (${T}, ${OUTRO})`
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-fcfg', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-fcfg', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'A'], [OUTRO, PV2, 'B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  app = await criarApp(); await app.ready()
})

beforeEach(limparFunil)

afterAll(async () => {
  await limparFunil()
  for (const t of [T, OUTRO]) {
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('Funil: bootstrap para tenant novo', () => {
  it('tenant sem etapa nenhuma recebe o modelo padrão ao ler as etapas', async () => {
    const [antes] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM funil_etapa WHERE tenant_id = ${T}`
    expect(antes!.n).toBe(0)

    const r = await chamar(T, 'GET', '/v1/funil/etapas')
    expect(r.statusCode).toBe(200)
    const chaves = r.json<{ itens: { chave: string }[] }>().itens.map((e) => e.chave)
    expect(chaves).toEqual(MODELOS_FUNIL['crm-recompra'].etapas.map((e) => e.chave))
  })

  it('os motivos de perda também nascem (perda exige motivo do catálogo)', async () => {
    const r = await chamar(T, 'GET', '/v1/funil/motivos')
    const codigos = r.json<{ itens: { codigo: string }[] }>().itens.map((m) => m.codigo).sort()
    expect(codigos).toEqual(MODELOS_FUNIL['crm-recompra'].motivos.map((m) => m.codigo).sort())
  })

  it('é idempotente: ler duas vezes não duplica', async () => {
    await chamar(T, 'GET', '/v1/funil/etapas')
    await chamar(T, 'GET', '/v1/funil/etapas')
    const [n] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM funil_etapa WHERE tenant_id = ${T}`
    expect(n!.n).toBe(MODELOS_FUNIL['crm-recompra'].etapas.length)
  })

  it('⚠️ não ressuscita etapa que o cliente apagou', async () => {
    await chamar(T, 'GET', '/v1/funil/etapas')
    const alvo = (await etapasCfg(T)).find((e) => e.chave === 'orcamento')!
    expect((await chamar(T, 'DELETE', `/v1/funil/config/etapas/${alvo.id}`)).statusCode).toBe(200)

    const depois = (await etapasCfg(T)).map((e) => e.chave)
    expect(depois).not.toContain('orcamento')
  })

  it('criar oportunidade funciona em tenant novo (antes dava 500 sem_etapa)', async () => {
    const contato = await novoContato(T)
    const r = await chamar(T, 'POST', '/v1/funil/oportunidades', { contatoId: contato })
    expect(r.statusCode).toBe(201)
  })

  it('⚠️ a etapa inicial é a primeira ABERTA, não a de chave "lead"', async () => {
    await chamar(T, 'GET', '/v1/funil/etapas')
    const lead = (await etapasCfg(T)).find((e) => e.chave === 'lead')!
    expect((await chamar(T, 'DELETE', `/v1/funil/config/etapas/${lead.id}`)).statusCode).toBe(200)

    const contato = await novoContato(T)
    const r = await chamar(T, 'POST', '/v1/funil/oportunidades', { contatoId: contato })
    expect(r.statusCode).toBe(201)

    const [op] = await dono<{ chave: string }[]>`
      SELECT e.chave FROM oportunidade o JOIN funil_etapa e ON e.tenant_id = o.tenant_id AND e.id = o.etapa_id
       WHERE o.tenant_id = ${T}`
    expect(op!.chave).toBe('conversa') // a próxima aberta por ordem
  })
})

describe('Funil: CRUD de etapas', () => {
  it('cria etapa com chave derivada do nome e sem colidir', async () => {
    await chamar(T, 'GET', '/v1/funil/etapas')
    const a = await chamar(T, 'POST', '/v1/funil/config/etapas', { nome: 'Demonstração', tipo: 'aberto' })
    const b = await chamar(T, 'POST', '/v1/funil/config/etapas', { nome: 'Demonstração', tipo: 'aberto' })
    expect(a.statusCode).toBe(201)
    expect(b.statusCode).toBe(201)

    const chaves = (await etapasCfg(T)).filter((e) => e.chave.startsWith('demonstracao_')).map((e) => e.chave)
    expect(chaves).toHaveLength(2)
    expect(new Set(chaves).size).toBe(2)
  })

  it('renomeia e reordena; tipo inválido é recusado', async () => {
    await chamar(T, 'GET', '/v1/funil/etapas')
    const alvo = (await etapasCfg(T)).find((e) => e.chave === 'conversa')!

    expect((await chamar(T, 'PATCH', `/v1/funil/config/etapas/${alvo.id}`,
      { nome: 'Contato feito', ordem: 7 })).statusCode).toBe(200)
    const depois = (await etapasCfg(T)).find((e) => e.id === alvo.id)!
    expect(depois.nome).toBe('Contato feito')
    expect(depois.ordem).toBe(7)
    expect(depois.chave).toBe('conversa') // ⚠️ chave é identidade estável, não muda

    expect((await chamar(T, 'PATCH', `/v1/funil/config/etapas/${alvo.id}`,
      { tipo: 'arquivado' })).statusCode).toBe(422)
  })

  it('⚠️ recusa deixar o funil sem nenhuma etapa aberta', async () => {
    await chamar(T, 'GET', '/v1/funil/etapas')
    const abertas = (await etapasCfg(T)).filter((e) => e.tipo === 'aberto' && e.ativo)
    // apaga todas menos a última
    for (const e of abertas.slice(0, -1)) {
      expect((await chamar(T, 'DELETE', `/v1/funil/config/etapas/${e.id}`)).statusCode).toBe(200)
    }
    const ultima = abertas[abertas.length - 1]!
    const rDel = await chamar(T, 'DELETE', `/v1/funil/config/etapas/${ultima.id}`)
    expect(rDel.statusCode).toBe(422)
    expect(rDel.json<{ erro: string }>().erro).toBe('etapa.ultima_aberta')

    const rPatch = await chamar(T, 'PATCH', `/v1/funil/config/etapas/${ultima.id}`, { ativo: false })
    expect(rPatch.statusCode).toBe(422)
  })

  it('⚠️ etapa COM card é desativada; etapa vazia é removida', async () => {
    await chamar(T, 'GET', '/v1/funil/etapas')
    const contato = await novoContato(T)
    await chamar(T, 'POST', '/v1/funil/oportunidades', { contatoId: contato })

    const comCard = (await etapasCfg(T)).find((e) => e.total > 0)!
    const rCard = await chamar(T, 'DELETE', `/v1/funil/config/etapas/${comCard.id}`)
    expect(rCard.json<{ estado: string }>().estado).toBe('desativada')
    const [aindaExiste] = await dono`SELECT 1 FROM funil_etapa WHERE tenant_id = ${T} AND id = ${comCard.id}`
    expect(aindaExiste).toBeTruthy() // não some — o histórico continua resolvendo

    const vazia = (await etapasCfg(T)).find((e) => e.total === 0 && e.tipo !== 'aberto')!
    const rVazia = await chamar(T, 'DELETE', `/v1/funil/config/etapas/${vazia.id}`)
    expect(rVazia.json<{ estado: string }>().estado).toBe('removida')
  })
})

describe('Funil: CRUD de motivos de perda', () => {
  it('cria motivo e desativa (em vez de apagar) o que já foi usado', async () => {
    await chamar(T, 'GET', '/v1/funil/etapas')
    const novo = await chamar(T, 'POST', '/v1/funil/config/motivos', { nome: 'Já tem sistema' })
    expect(novo.statusCode).toBe(201)
    const codigo = novo.json<{ codigo: string }>().codigo
    expect(codigo).toMatch(/^ja_tem_sistema_/)

    // usa o motivo numa perda
    const contato = await novoContato(T)
    const criada = await chamar(T, 'POST', '/v1/funil/oportunidades', { contatoId: contato })
    const opId = criada.json<{ id: string }>().id
    const perdido = (await etapasCfg(T)).find((e) => e.tipo === 'perdido')!
    const mov = await chamar(T, 'POST', `/v1/funil/oportunidades/${opId}/mover`,
      { etapaId: perdido.id, versao: 0, motivo: codigo })
    expect(mov.statusCode).toBe(200)

    const rDel = await chamar(T, 'DELETE', `/v1/funil/config/motivos/${codigo}`)
    expect(rDel.json<{ estado: string }>().estado).toBe('desativado')

    // some da lista de escolha, mas continua resolvendo no relatório
    const restantes = (await chamar(T, 'GET', '/v1/funil/motivos')).json<{ itens: { codigo: string }[] }>().itens
    expect(restantes.map((m) => m.codigo)).not.toContain(codigo)
    const met = await chamar(T, 'GET', '/v1/funil/metricas')
    expect(met.json<{ perda: { motivos: { codigo: string }[] } }>().perda.motivos.map((m) => m.codigo)).toContain(codigo)
  })

  it('motivo nunca usado é removido de fato', async () => {
    await chamar(T, 'GET', '/v1/funil/etapas')
    const codigo = (await chamar(T, 'POST', '/v1/funil/config/motivos', { nome: 'Porte insuficiente' }))
      .json<{ codigo: string }>().codigo
    const r = await chamar(T, 'DELETE', `/v1/funil/config/motivos/${codigo}`)
    expect(r.json<{ estado: string }>().estado).toBe('removido')
  })
})

describe('Funil: isolamento por tenant (RLS)', () => {
  it('⚠️ etapa criada em A não aparece nem é editável em B', async () => {
    await chamar(T, 'GET', '/v1/funil/etapas')
    await chamar(OUTRO, 'GET', '/v1/funil/etapas')
    const daA = (await chamar(T, 'POST', '/v1/funil/config/etapas', { nome: 'Só do A' })).json<{ id: string }>().id

    expect((await etapasCfg(OUTRO)).map((e) => e.id)).not.toContain(daA)
    expect((await chamar(OUTRO, 'PATCH', `/v1/funil/config/etapas/${daA}`, { nome: 'invadido' })).statusCode).toBe(404)
    expect((await chamar(OUTRO, 'DELETE', `/v1/funil/config/etapas/${daA}`)).statusCode).toBe(404)

    const [intacta] = await dono<{ nome: string }[]>`SELECT nome FROM funil_etapa WHERE tenant_id = ${T} AND id = ${daA}`
    expect(intacta!.nome).toBe('Só do A')
  })
})
