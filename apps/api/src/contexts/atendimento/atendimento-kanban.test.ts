import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'

/** Kanban de atendimentos: seed, assumir→etapa, mover (estado+aging+versão), fila, config. */
const T = 'a7e70000-0000-4000-8000-000000000001'
const OUTRO = 'a7e70000-0000-4000-8000-000000000002'
const PV = 'a7e70000-1111-4000-8000-000000000001'
const PV2 = 'a7e70000-1111-4000-8000-000000000002'
const PLANO = 'a7e70000-3333-4000-8000-000000000001'
const MODELO = 'a7e70000-4444-4000-8000-000000000001'
const C = 'a7e70000-6666-4000-8000-000000000001'
const CANAL = 'a7e70000-7777-4000-8000-000000000001'
const CONV = 'a7e70000-8888-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const chamar = (t: string, m: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, corpo?: Record<string, unknown>) =>
  app.inject({ method: m, url, headers: { 'x-tenant-id': t }, ...(corpo ? { payload: corpo } : {}) })

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-ak', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-ak', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'A'], [OUTRO, PV2, 'B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES (${T}, ${C}, 'Cliente AK', 'teste', true) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES (${T}, ${CANAL}, 'whatsapp_oficial', 'Zap', 'conectado') ON CONFLICT DO NOTHING`
  app = await criarApp(); await app.ready()
})

beforeEach(async () => {
  // Conversa entrante SEM atendimento aberto → aparece na fila derivada.
  await dono`DELETE FROM atendimento_etapa_historico WHERE tenant_id = ${T}`
  await dono`DELETE FROM atendimento WHERE tenant_id = ${T}`
  await dono`DELETE FROM conversa WHERE tenant_id = ${T}`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, ultima_direcao, ultima_mensagem_em)
             VALUES (${T}, ${CONV}, ${CANAL}, ${C}, 'entrante', now())`
})

afterAll(async () => {
  await dono`DELETE FROM atendimento_etapa_historico WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM atendimento WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM conversa WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM atendimento_etapa WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM canal_conectado WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM contato WHERE tenant_id IN (${T}, ${OUTRO})`
  for (const t of [T, OUTRO]) {
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

type Etapas = { aguardando: { total: number }; itens: { id: string; chave: string; tipo: string; total: number }[] }
const etapas = async () => (await chamar(T, 'GET', '/v1/atendimento-kanban/etapas')).json() as Etapas
const etapaId = (e: Etapas, chave: string) => e.itens.find((x) => x.chave === chave)!.id

describe('Kanban de atendimentos', () => {
  it('etapas auto-semeadas + fila derivada; assumir cai na 1ª etapa; card sem conteúdo', async () => {
    const e = await etapas()
    expect(e.itens.map((x) => x.chave)).toEqual(['em_atendimento', 'aguardando_cliente', 'aguardando_nos', 'resolvido'])
    expect(e.aguardando.total).toBe(1) // a conversa entrante sem atendimento

    // Assumir → cria atendimento na 1ª etapa 'atendimento'.
    expect((await chamar(T, 'POST', `/v1/conversas/${CONV}/assumir`)).statusCode).toBe(201)
    const col = (await chamar(T, 'GET', `/v1/atendimento-kanban/coluna/${etapaId(e, 'em_atendimento')}`)).json() as {
      itens: { atendimentoId: string; contato: string; protocolo: number; versao: number; conteudo?: unknown }[]
    }
    expect(col.itens.length).toBe(1)
    expect(col.itens[0]).toMatchObject({ contato: 'Cliente AK' })
    expect(col.itens[0]!.protocolo).toBeGreaterThan(0)
    expect('conteudo' in col.itens[0]!).toBe(false) // ⚠️ só metadados, sem conteúdo da conversa
    // Fila agora está vazia (a conversa foi assumida).
    expect((await etapas()).aguardando.total).toBe(0)
  })

  it('mover para etapa "resolvido" (encerrado) fecha o atendimento; versão em conflito → 409', async () => {
    await chamar(T, 'POST', `/v1/conversas/${CONV}/assumir`)
    const e = await etapas()
    const col = (await chamar(T, 'GET', `/v1/atendimento-kanban/coluna/${etapaId(e, 'em_atendimento')}`)).json() as { itens: { atendimentoId: string; versao: number }[] }
    const at = col.itens[0]!

    // Versão errada → 409.
    expect((await chamar(T, 'POST', `/v1/atendimento-kanban/${at.atendimentoId}/mover`, { etapaId: etapaId(e, 'resolvido'), versao: at.versao + 5 })).statusCode).toBe(409)

    // Mover certo → encerra.
    expect((await chamar(T, 'POST', `/v1/atendimento-kanban/${at.atendimentoId}/mover`, { etapaId: etapaId(e, 'resolvido'), versao: at.versao })).statusCode).toBe(200)
    const [a] = await dono<{ estado: string; encerrado_em: Date | null; etapa_id: string }[]>`
      SELECT estado, encerrado_em, etapa_id FROM atendimento WHERE tenant_id = ${T} AND id = ${at.atendimentoId}`
    expect(a!.estado).toBe('encerrado')
    expect(a!.encerrado_em).not.toBeNull()
    expect(a!.etapa_id).toBe(etapaId(e, 'resolvido'))
    // Histórico: a estadia anterior fechou (saiu_em) e a nova abriu.
    const hist = await dono<{ saiu_em: Date | null }[]>`
      SELECT saiu_em FROM atendimento_etapa_historico WHERE tenant_id = ${T} AND atendimento_id = ${at.atendimentoId} ORDER BY entrou_em`
    expect(hist.length).toBe(2)
    expect(hist[0]!.saiu_em).not.toBeNull()
    expect(hist[1]!.saiu_em).toBeNull()
  })

  it('config: cria etapa; DELETE com atendimento na etapa DESATIVA (não apaga)', async () => {
    // Cria uma etapa nova.
    const criar = await chamar(T, 'POST', '/v1/atendimento-kanban/config/etapas', { nome: 'Aguardando nós', tipo: 'atendimento' })
    expect(criar.statusCode).toBe(201)
    const novaId = (criar.json() as { id: string }).id
    // Renomeia.
    expect((await chamar(T, 'PATCH', `/v1/atendimento-kanban/config/etapas/${novaId}`, { nome: 'Aguardando interno' })).statusCode).toBe(200)

    // Coloca um atendimento na etapa 'resolvido' e tenta apagá-la → desativa.
    await chamar(T, 'POST', `/v1/conversas/${CONV}/assumir`)
    const e = await etapas()
    const col = (await chamar(T, 'GET', `/v1/atendimento-kanban/coluna/${etapaId(e, 'em_atendimento')}`)).json() as { itens: { atendimentoId: string; versao: number }[] }
    await chamar(T, 'POST', `/v1/atendimento-kanban/${col.itens[0]!.atendimentoId}/mover`, { etapaId: etapaId(e, 'resolvido'), versao: col.itens[0]!.versao })
    const del = await chamar(T, 'DELETE', `/v1/atendimento-kanban/config/etapas/${etapaId(e, 'resolvido')}`)
    expect(del.statusCode).toBe(200)
    expect((del.json() as { estado: string }).estado).toBe('desativada')
    // A etapa vazia recém-criada pode ser removida de fato.
    expect(((await chamar(T, 'DELETE', `/v1/atendimento-kanban/config/etapas/${novaId}`)).json() as { estado: string }).estado).toBe('removida')
  })

  it('⚠️ isolamento: kanban de um tenant não vê atendimento de outro', async () => {
    await chamar(T, 'POST', `/v1/conversas/${CONV}/assumir`)
    const e = await etapas()
    // OUTRO tenant: sua coluna 'em_atendimento' não traz o atendimento de T.
    const eOutro = (await chamar(OUTRO, 'GET', '/v1/atendimento-kanban/etapas')).json() as Etapas
    const colOutro = (await chamar(OUTRO, 'GET', `/v1/atendimento-kanban/coluna/${etapaId(eOutro, 'em_atendimento')}`)).json() as { itens: unknown[] }
    expect(colOutro.itens.length).toBe(0)
    void e
  })
})
