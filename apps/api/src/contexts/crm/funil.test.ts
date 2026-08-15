import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'

/**
 * Onda 2 — Kanban do funil de relacionamento. Fixa: criar (1 aberta por contato),
 * coluna por cursor, mover com histórico, concorrência otimista (versao), perda
 * com motivo obrigatório, e isolamento por tenant.
 */
const T = 'f0f10000-0000-4000-8000-000000000001'
const OUTRO = 'f0f10000-0000-4000-8000-000000000002'
const PV = 'f0f10000-1111-4000-8000-000000000001'
const PV2 = 'f0f10000-1111-4000-8000-000000000002'
const PLANO = 'f0f10000-3333-4000-8000-000000000001'
const MODELO = 'f0f10000-4444-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const chamar = (t: string, m: 'GET' | 'POST', url: string, corpo?: Record<string, unknown>) =>
  app.inject({ method: m, url, headers: { 'x-tenant-id': t }, ...(corpo ? { payload: corpo } : {}) })

const novoContato = async (t: string, nome: string) => {
  const id = randomUUID()
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES (${t}, ${id}, ${nome}, 'teste', true)`
  return id
}
const etapaId = async (t: string, chave: string) => {
  const [e] = await dono<{ id: string }[]>`SELECT id FROM funil_etapa WHERE tenant_id = ${t} AND chave = ${chave}`
  return e!.id
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-funil', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-funil', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'A'], [OUTRO, PV2, 'B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
    // Semeia os estágios do funil para o tenant de teste (0034 semeia só os existentes na migração).
    await dono`INSERT INTO funil_etapa (tenant_id, id, ordem, chave, nome, tipo) VALUES
      (${t}, ${randomUUID()}, 1, 'lead', 'Lead', 'aberto'),
      (${t}, ${randomUUID()}, 2, 'conversa', 'Em conversa', 'aberto'),
      (${t}, ${randomUUID()}, 4, 'pedido', '1º pedido', 'ganho'),
      (${t}, ${randomUUID()}, 9, 'perdido', 'Perdido', 'perdido') ON CONFLICT (tenant_id, chave) DO NOTHING`
    await dono`INSERT INTO motivo_perda (tenant_id, codigo, nome) VALUES (${t}, 'preco', 'Preço') ON CONFLICT DO NOTHING`
  }
  app = await criarApp(); await app.ready()
})

beforeEach(async () => {
  await dono`DELETE FROM oportunidade_etapa_historico WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM oportunidade WHERE tenant_id IN (${T}, ${OUTRO})`
})

afterAll(async () => {
  await dono`DELETE FROM oportunidade_etapa_historico WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM oportunidade WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM contato WHERE tenant_id IN (${T}, ${OUTRO})`
  for (const t of [T, OUTRO]) {
    await dono`DELETE FROM motivo_perda WHERE tenant_id = ${t}`
    await dono`DELETE FROM funil_etapa WHERE tenant_id = ${t}`
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('Onda 2: Kanban do funil', () => {
  it('etapas vêm ordenadas com contagem; motivos listados', async () => {
    const et = await chamar(T, 'GET', '/v1/funil/etapas')
    const chaves = (et.json() as { itens: { chave: string }[] }).itens.map((e) => e.chave)
    expect(chaves).toEqual(['lead', 'conversa', 'pedido', 'perdido'])
    const mot = await chamar(T, 'GET', '/v1/funil/motivos')
    expect((mot.json() as { itens: unknown[] }).itens.length).toBeGreaterThan(0)
  })

  it('cria oportunidade no lead; segunda no mesmo contato → 409', async () => {
    const c = await novoContato(T, 'Cliente Zé')
    const r1 = await chamar(T, 'POST', '/v1/funil/oportunidades', { contatoId: c })
    expect(r1.statusCode).toBe(201)
    const r2 = await chamar(T, 'POST', '/v1/funil/oportunidades', { contatoId: c })
    expect(r2.statusCode).toBe(409)
  })

  it('mover: card sai do lead e entra em conversa, com histórico', async () => {
    const c = await novoContato(T, 'Ana')
    const op = (await chamar(T, 'POST', '/v1/funil/oportunidades', { contatoId: c }).then((r) => r.json())) as { id: string }
    const conversa = await etapaId(T, 'conversa')
    const mv = await chamar(T, 'POST', `/v1/funil/oportunidades/${op.id}/mover`, { etapaId: conversa, versao: 0, posicao: 10 })
    expect(mv.statusCode).toBe(200)
    const [o] = await dono<{ etapa_id: string; versao: string }[]>`SELECT etapa_id, versao::text FROM oportunidade WHERE tenant_id = ${T} AND id = ${op.id}`
    expect(o!.etapa_id).toBe(conversa)
    expect(o!.versao).toBe('1')
    const [h] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM oportunidade_etapa_historico WHERE tenant_id = ${T} AND oportunidade_id = ${op.id}`
    expect(h!.n).toBe(2) // lead + conversa
  })

  it('⚠️ concorrência otimista: mover com versao velha → 409', async () => {
    const c = await novoContato(T, 'Bia')
    const op = (await chamar(T, 'POST', '/v1/funil/oportunidades', { contatoId: c }).then((r) => r.json())) as { id: string }
    const conversa = await etapaId(T, 'conversa')
    await chamar(T, 'POST', `/v1/funil/oportunidades/${op.id}/mover`, { etapaId: conversa, versao: 0 }) // vira versao 1
    const tarde = await chamar(T, 'POST', `/v1/funil/oportunidades/${op.id}/mover`, { etapaId: conversa, versao: 0 }) // versao velha
    expect(tarde.statusCode).toBe(409)
  })

  it('⚠️ perda exige motivo; sem motivo → 422, com motivo → fecha', async () => {
    const c = await novoContato(T, 'Léo')
    const op = (await chamar(T, 'POST', '/v1/funil/oportunidades', { contatoId: c }).then((r) => r.json())) as { id: string }
    const perdido = await etapaId(T, 'perdido')
    const sem = await chamar(T, 'POST', `/v1/funil/oportunidades/${op.id}/mover`, { etapaId: perdido, versao: 0 })
    expect(sem.statusCode).toBe(422)
    const com = await chamar(T, 'POST', `/v1/funil/oportunidades/${op.id}/mover`, { etapaId: perdido, versao: 0, motivo: 'preco' })
    expect(com.statusCode).toBe(200)
    const [o] = await dono<{ estado: string; motivo: string | null }[]>`SELECT estado, motivo_perda_codigo AS motivo FROM oportunidade WHERE tenant_id = ${T} AND id = ${op.id}`
    expect(o!.estado).toBe('perdida')
    expect(o!.motivo).toBe('preco')
    // Perdida libera o contato para nova oportunidade aberta.
    const nova = await chamar(T, 'POST', '/v1/funil/oportunidades', { contatoId: c })
    expect(nova.statusCode).toBe(201)
  })

  it('coluna paginada por cursor: 3 cards com PAGINA baixa não faz sentido — valida ordenação por posicao', async () => {
    const lead = await etapaId(T, 'lead')
    for (let i = 0; i < 3; i++) {
      const c = await novoContato(T, `C${i}`)
      const op = (await chamar(T, 'POST', '/v1/funil/oportunidades', { contatoId: c }).then((r) => r.json())) as { id: string }
      await dono`UPDATE oportunidade SET posicao = ${100 - i} WHERE tenant_id = ${T} AND id = ${op.id}`
    }
    const col = await chamar(T, 'GET', `/v1/funil/coluna/${lead}`)
    const pos = (col.json() as { itens: { nome: string }[] }).itens.map((c) => c.nome)
    expect(pos).toEqual(['C2', 'C1', 'C0']) // posicao 98,99,100 → ordem crescente
  })

  it('⚠️ isolamento: coluna de um tenant não traz card de outro (RLS)', async () => {
    const cOutro = await novoContato(OUTRO, 'De outro')
    await chamar(OUTRO, 'POST', '/v1/funil/oportunidades', { contatoId: cOutro })
    const lead = await etapaId(T, 'lead')
    const col = await chamar(T, 'GET', `/v1/funil/coluna/${lead}`)
    expect((col.json() as { itens: unknown[] }).itens.length).toBe(0)
  })

  it('métricas: entraram por estágio, conversão A→B, tempo médio e perda com motivo', async () => {
    const lead = await etapaId(T, 'lead'), conversa = await etapaId(T, 'conversa')
    const pedido = await etapaId(T, 'pedido')
    const c1 = await novoContato(T, 'M1'), c2 = await novoContato(T, 'M2'), c3 = await novoContato(T, 'M3')
    const op1 = randomUUID(), op2 = randomUUID(), op3 = randomUUID()
    // c1: passou por lead→conversa→pedido (aberta em pedido). c2: lead→conversa.
    // c3: só lead, PERDIDA com motivo. Histórico direto p/ tempos determinísticos.
    await dono`INSERT INTO oportunidade (tenant_id, id, contato_id, etapa_id, estado) VALUES
      (${T}, ${op1}, ${c1}, ${pedido}, 'aberta'),
      (${T}, ${op2}, ${c2}, ${conversa}, 'aberta')`
    // ⚠️ Perdida precisa do motivo no PRÓPRIO insert (CHECK no banco).
    await dono`INSERT INTO oportunidade (tenant_id, id, contato_id, etapa_id, estado, motivo_perda_codigo, fechada_em)
      VALUES (${T}, ${op3}, ${c3}, ${lead}, 'perdida', 'preco', now())`
    const h = (op: string, et: string, d1: number, d2: number | null) =>
      dono`INSERT INTO oportunidade_etapa_historico (tenant_id, id, oportunidade_id, etapa_id, entrou_em, saiu_em)
           VALUES (${T}, ${randomUUID()}, ${op}, ${et}, now() - ${d1 + ' days'}::interval,
                   ${d2 === null ? null : dono`now() - ${d2 + ' days'}::interval`})`
    await h(op1, lead, 10, 8); await h(op1, conversa, 8, 5); await h(op1, pedido, 5, null)
    await h(op2, lead, 6, 4); await h(op2, conversa, 4, null)
    await h(op3, lead, 3, null)

    const m = (await chamar(T, 'GET', '/v1/funil/metricas').then((r) => r.json())) as {
      etapas: { chave: string; entraram: number; conversaoParaProxima: number | null; tempoMedioDias: number | null }[]
      perda: { perdidas: number; fechadas: number; motivos: { codigo: string; qtd: number }[] }
      recompra: { comCompra: number; taxa: number | null }
      tempoSegundoPedido: { base: number }
    }
    const et = (k: string) => m.etapas.find((e) => e.chave === k)!
    expect(et('lead').entraram).toBe(3)
    expect(et('conversa').entraram).toBe(2)
    expect(et('pedido').entraram).toBe(1)
    // conversão lead→conversa = 2/3 = 66.7% ; conversa→pedido = 1/2 = 50%
    expect(et('lead').conversaoParaProxima).toBe(66.7)
    expect(et('conversa').conversaoParaProxima).toBe(50)
    // tempo médio no lead: só estadias concluídas (c1=2d, c2=2d; c3 em aberto não conta) = 2d
    expect(et('lead').tempoMedioDias).toBe(2)
    // perda: 1 perdida de 1 fechada, motivo 'preco'
    expect(m.perda.perdidas).toBe(1)
    expect(m.perda.motivos.find((x) => x.codigo === 'preco')?.qtd).toBe(1)
    // estrutura de recompra presente (valores vêm da MV de vendas)
    expect(m.recompra).toHaveProperty('comCompra')
    expect(m.tempoSegundoPedido).toHaveProperty('base')
  })
})
