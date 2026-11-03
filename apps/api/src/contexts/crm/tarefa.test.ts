import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'

/** Tarefas de follow-up — CRUD + situação derivada. */
const T = 'fa5e0000-0000-4000-8000-000000000001'
const OUTRO = 'fa5e0000-0000-4000-8000-000000000002'
const PV = 'fa5e0000-1111-4000-8000-000000000001'
const PV2 = 'fa5e0000-1111-4000-8000-000000000002'
const PLANO = 'fa5e0000-3333-4000-8000-000000000001'
const MODELO = 'fa5e0000-4444-4000-8000-000000000001'
const C1 = 'fa5e0000-5555-4000-8000-000000000001'
const C2 = 'fa5e0000-5555-4000-8000-000000000002'
const CO = 'fa5e0000-5555-4000-8000-000000000003'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const chamar = (t: string, m: 'GET' | 'POST', url: string, corpo?: Record<string, unknown>) =>
  app.inject({ method: m, url, headers: { 'x-tenant-id': t }, ...(corpo ? { payload: corpo } : {}) })

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-ta', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-ta', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'A'], [OUTRO, PV2, 'B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await dono`INSERT INTO contato (tenant_id, id, nome) VALUES (${T}, ${C1}, 'Maria Compradora'), (${T}, ${C2}, 'João Atacado'), (${OUTRO}, ${CO}, 'De Outro') ON CONFLICT DO NOTHING`
  app = await criarApp(); await app.ready()
})
beforeEach(async () => {
  await dono`DELETE FROM tarefa WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`UPDATE tenant SET fuso = 'America/Sao_Paulo' WHERE id = ${T}`
})
afterAll(async () => {
  await dono`DELETE FROM tarefa WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM contato WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM auditoria WHERE tenant_id IN (${T}, ${OUTRO}) AND acao = 'tarefa.lote'`
  await dono`DELETE FROM usuario WHERE tenant_id IN (${T}, ${OUTRO})`
  for (const t of [T, OUTRO]) {
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

const criar = (t: string, venceEm: string, titulo = 'Ligar') =>
  chamar(t, 'POST', '/v1/tarefas', { titulo, venceEm })

describe('Tarefas de follow-up', () => {
  it('cria; título/vencimento obrigatórios', async () => {
    expect((await criar(T, new Date(Date.now() + 86400000).toISOString())).statusCode).toBe(201)
    expect((await chamar(T, 'POST', '/v1/tarefas', { titulo: 'x' })).statusCode).toBe(422) // sem vencimento
    expect((await chamar(T, 'POST', '/v1/tarefas', { venceEm: new Date().toISOString() })).statusCode).toBe(422) // sem título
  })

  it('⚠️ "vencida" é derivada: passado → vencida; futuro → não', async () => {
    await criar(T, new Date(Date.now() - 86400000).toISOString(), 'Atrasada')
    await criar(T, new Date(Date.now() + 86400000).toISOString(), 'Futura')
    const vencidas = await chamar(T, 'GET', '/v1/tarefas?situacao=vencidas')
    const nomes = (vencidas.json() as { itens: { titulo: string; vencida: boolean }[] }).itens
    expect(nomes.length).toBe(1)
    expect(nomes[0]).toMatchObject({ titulo: 'Atrasada', vencida: true })
  })

  it('concluir tira das abertas; concluir de novo → 409', async () => {
    await criar(T, new Date(Date.now() + 86400000).toISOString())
    const [t] = await dono<{ id: string }[]>`SELECT id FROM tarefa WHERE tenant_id=${T} LIMIT 1`
    expect((await chamar(T, 'POST', `/v1/tarefas/${t!.id}/concluir`)).statusCode).toBe(200)
    expect((await chamar(T, 'POST', `/v1/tarefas/${t!.id}/concluir`)).statusCode).toBe(409)
    const abertas = await chamar(T, 'GET', '/v1/tarefas?situacao=abertas')
    expect((abertas.json() as { itens: unknown[] }).itens.length).toBe(0)
    const concluidas = await chamar(T, 'GET', '/v1/tarefas?situacao=concluidas')
    expect((concluidas.json() as { itens: unknown[] }).itens.length).toBe(1)
  })

  it('⚠️ isolamento: tarefa de um tenant não aparece para outro (RLS)', async () => {
    await criar(OUTRO, new Date(Date.now() + 86400000).toISOString())
    expect((await chamar(T, 'GET', '/v1/tarefas').then((r) => (r.json() as { itens: unknown[] }).itens.length))).toBe(0)
  })
})

const json = <X>(r: { json: () => unknown }) => r.json() as X
const em = (ms: number) => new Date(Date.now() + ms).toISOString()
const H = 3600_000
type Lista = { itens: { titulo: string; tipo: string; contato: string | null; resultado: string | null }[]; proximoCursor: string | null }

describe('Tarefas v2 — campos e filtros', () => {
  it('cria com tipo, descrição e responsável; tipo inválido → 422; responsável de outro tenant → 422', async () => {
    const eu = await chamar(T, 'POST', '/v1/tarefas', { titulo: 'Visitar', venceEm: em(H), tipo: 'visita', descricao: 'levar amostra', contatoId: C1 })
    expect(eu.statusCode).toBe(201)
    const [row] = await dono<{ tipo: string; descricao: string; responsavel_id: string | null }[]>`SELECT tipo, descricao, responsavel_id FROM tarefa WHERE tenant_id=${T}`
    expect(row).toMatchObject({ tipo: 'visita', descricao: 'levar amostra' })
    expect(row!.responsavel_id).not.toBeNull() // padrão: quem criou
    expect((await chamar(T, 'POST', '/v1/tarefas', { titulo: 'x', venceEm: em(H), tipo: 'fax' })).statusCode).toBe(422)
    const [ou] = await dono<{ id: string }[]>`INSERT INTO usuario (tenant_id, id, nome, email) VALUES (${OUTRO}, gen_random_uuid(), 'Z', 'z@b.com') ON CONFLICT DO NOTHING RETURNING id`
    if (ou) expect((await chamar(T, 'POST', '/v1/tarefas', { titulo: 'x', venceEm: em(H), responsavelId: ou.id })).statusCode).toBe(422)
  })

  it('filtra por tipo, responsável, busca (título/contato), período e contato', async () => {
    await chamar(T, 'POST', '/v1/tarefas', { titulo: 'Ligar renovação', venceEm: em(2 * H), tipo: 'ligacao', contatoId: C1 })
    await chamar(T, 'POST', '/v1/tarefas', { titulo: 'Enviar proposta', venceEm: em(30 * H), tipo: 'email', contatoId: C2 })
    const lista = async (qs: string) => json<Lista>(await chamar(T, 'GET', `/v1/tarefas?${qs}`)).itens.map((i) => i.titulo)
    expect(await lista('tipo=ligacao')).toEqual(['Ligar renovação'])
    expect(await lista('q=proposta')).toEqual(['Enviar proposta'])
    expect(await lista('q=Maria')).toEqual(['Ligar renovação']) // pelo nome do contato
    expect(await lista(`contatoId=${C2}`)).toEqual(['Enviar proposta'])
    const [resp] = await dono<{ id: string }[]>`SELECT responsavel_id AS id FROM tarefa WHERE tenant_id=${T} LIMIT 1`
    expect((await lista(`responsavelId=${resp!.id}`)).length).toBe(2)
    expect(await lista(`responsavelId=${C1}`)).toEqual([])
    const depois = new Date(Date.now() + 20 * H).toISOString().slice(0, 10)
    expect(await lista(`de=${depois}`)).toEqual(['Enviar proposta'])
    expect(await lista(`ate=${new Date(Date.now() + 3 * H).toISOString().slice(0, 10)}&tipo=ligacao`)).toEqual(['Ligar renovação'])
    expect((await chamar(T, 'GET', '/v1/tarefas?tipo=fax')).statusCode).toBe(422)
    expect((await chamar(T, 'GET', '/v1/tarefas?de=ontem')).statusCode).toBe(422)
  })

  it('q com % literal não vira curinga', async () => {
    await chamar(T, 'POST', '/v1/tarefas', { titulo: 'Desconto 10%', venceEm: em(H) })
    await chamar(T, 'POST', '/v1/tarefas', { titulo: 'Outra coisa', venceEm: em(H) })
    expect(json<Lista>(await chamar(T, 'GET', '/v1/tarefas?q=%25')).itens.map((i) => i.titulo)).toEqual(['Desconto 10%'])
  })

  it('cursor pagina sem repetir (31 tarefas)', async () => {
    for (let i = 0; i < 31; i++) await chamar(T, 'POST', '/v1/tarefas', { titulo: `T${i}`, venceEm: em((i + 1) * 60_000) })
    const p1 = json<Lista>(await chamar(T, 'GET', '/v1/tarefas?situacao=abertas'))
    expect(p1.itens.length).toBe(30)
    expect(p1.proximoCursor).not.toBeNull()
    const p2 = json<Lista>(await chamar(T, 'GET', `/v1/tarefas?situacao=abertas&cursor=${p1.proximoCursor}`))
    expect(p2.itens.map((i) => i.titulo)).toEqual(['T30'])
    expect(p2.proximoCursor).toBeNull()
  })
})

describe('Tarefas v2 — contadores no fuso do tenant', () => {
  const contadores = async (t = T) => json<{ pendentes: number; atrasadas: number; hoje: number; semana: number }>(await chamar(t, 'GET', '/v1/tarefas/contadores'))

  it('fronteira do dia local (início inclusivo, fim exclusivo), com o relógio do banco', async () => {
    const fuso = 'Pacific/Kiritimati' // UTC+14: o dia local quase nunca coincide com o dia UTC
    await dono`UPDATE tenant SET fuso = ${fuso} WHERE id = ${T}`
    const [l] = await dono<{ ini: Date; fim: Date }[]>`
      SELECT date_trunc('day', now() AT TIME ZONE ${fuso}::text) AT TIME ZONE ${fuso}::text AS ini,
             (date_trunc('day', now() AT TIME ZONE ${fuso}::text) + interval '1 day') AT TIME ZONE ${fuso}::text AS fim`
    const ini = l!.ini.getTime(), fim = l!.fim.getTime()
    await criar(T, new Date(ini - 60_000).toISOString(), 'ontem 23:59')
    await criar(T, new Date(ini).toISOString(), 'hoje 00:00')
    await criar(T, new Date(fim - 60_000).toISOString(), 'hoje 23:59')
    await criar(T, new Date(fim).toISOString(), 'amanhã 00:00')
    const c = await contadores()
    expect(c.pendentes).toBe(4)
    expect(c.hoje).toBe(2)
    const hoje = json<Lista>(await chamar(T, 'GET', '/v1/tarefas?situacao=hoje')).itens.map((i) => i.titulo)
    expect(hoje.sort()).toEqual(['hoje 00:00', 'hoje 23:59'])
  })

  it('atrasadas, semana e fuso inválido não derruba (cai no padrão)', async () => {
    await criar(T, em(-2 * H), 'atrasada')
    await criar(T, em(40 * 24 * H), 'longe')
    const c = await contadores()
    expect(c).toMatchObject({ pendentes: 2, atrasadas: 1 })
    expect(c.semana).toBeLessThanOrEqual(2)
    await dono`UPDATE tenant SET fuso = 'Brasil/Ceara' WHERE id = ${T}`
    expect((await chamar(T, 'GET', '/v1/tarefas/contadores')).statusCode).toBe(200)
  })

  it('só conta abertas, e só do próprio tenant', async () => {
    await criar(T, em(H), 'a'); await criar(OUTRO, em(H), 'b')
    const [t] = await dono<{ id: string }[]>`SELECT id FROM tarefa WHERE tenant_id=${T}`
    await chamar(T, 'POST', `/v1/tarefas/${t!.id}/cancelar`)
    expect((await contadores()).pendentes).toBe(0)
    expect((await contadores(OUTRO)).pendentes).toBe(1)
  })
})

describe('Tarefas v2 — concluir com resultado', () => {
  it('grava resultado e quem concluiu; resultado opcional; limite de tamanho', async () => {
    await criar(T, em(H), 'A'); await criar(T, em(2 * H), 'B')
    const ids = (await dono<{ id: string }[]>`SELECT id FROM tarefa WHERE tenant_id=${T} ORDER BY vence_em`).map((r) => r.id)
    expect((await chamar(T, 'POST', `/v1/tarefas/${ids[0]}/concluir`, { resultado: '  Fechou o pedido  ' })).statusCode).toBe(200)
    expect((await chamar(T, 'POST', `/v1/tarefas/${ids[1]}/concluir`)).statusCode).toBe(200)
    const [a] = await dono<{ resultado: string | null; concluida_por: string | null }[]>`SELECT resultado, concluida_por FROM tarefa WHERE id=${ids[0]!}`
    expect(a!.resultado).toBe('Fechou o pedido')
    expect(a!.concluida_por).not.toBeNull()
    const [b] = await dono<{ resultado: string | null }[]>`SELECT resultado FROM tarefa WHERE id=${ids[1]!}`
    expect(b!.resultado).toBeNull()
    await criar(T, em(H), 'C')
    const [c] = await dono<{ id: string }[]>`SELECT id FROM tarefa WHERE tenant_id=${T} AND estado='aberta'`
    expect((await chamar(T, 'POST', `/v1/tarefas/${c!.id}/concluir`, { resultado: 'x'.repeat(2001) })).statusCode).toBe(422)
    const conc = json<Lista>(await chamar(T, 'GET', '/v1/tarefas?situacao=concluidas')).itens.map((i) => i.resultado)
    expect(conc).toContain('Fechou o pedido')
  })
})

describe('Tarefas v2 — lote', () => {
  const lote = (t: string, corpo: Record<string, unknown>) => chamar(t, 'POST', '/v1/tarefas/lote', corpo)

  it('cria uma por contato, audita, e ignora contato de outro tenant', async () => {
    const r = await lote(T, { contatoIds: [C1, C2, CO], titulo: 'Reativar', tipo: 'whatsapp', venceEm: em(H), descricao: 'campanha' })
    expect(r.statusCode).toBe(201)
    expect(json<{ criadas: number; ignorados: number }>(r)).toEqual({ criadas: 2, ignorados: 1 })
    expect((await dono`SELECT 1 FROM tarefa WHERE tenant_id=${T} AND tipo='whatsapp'`).length).toBe(2)
    expect((await dono`SELECT 1 FROM tarefa WHERE tenant_id=${OUTRO}`).length).toBe(0)
    expect((await dono`SELECT 1 FROM auditoria WHERE tenant_id=${T} AND acao='tarefa.lote'`).length).toBe(1)
  })

  it('limite de 500, lista vazia e título/vencimento inválidos → 422 e nada criado', async () => {
    const muitos = Array.from({ length: 501 }, (_, i) => `fa5e0000-9999-4000-8000-${String(i).padStart(12, '0')}`)
    expect((await lote(T, { contatoIds: muitos, titulo: 'x', venceEm: em(H) })).statusCode).toBe(422)
    expect((await lote(T, { contatoIds: [], titulo: 'x', venceEm: em(H) })).statusCode).toBe(422)
    expect((await lote(T, { contatoIds: [C1], venceEm: em(H) })).statusCode).toBe(422)
    expect((await lote(T, { contatoIds: [C1], titulo: 'x', venceEm: 'nada' })).statusCode).toBe(422)
    expect((await lote(T, { contatoIds: [C1, 'nao-uuid'], titulo: 'x', venceEm: em(H) })).statusCode).toBe(422)
    expect((await dono`SELECT 1 FROM tarefa WHERE tenant_id=${T}`).length).toBe(0)
  })

  it('exatamente 500 ids é aceito', async () => {
    const ids = [C1, ...Array.from({ length: 499 }, (_, i) => `fa5e0000-9999-4000-8000-${String(i).padStart(12, '0')}`)]
    const r = await lote(T, { contatoIds: ids, titulo: 'x', venceEm: em(H) })
    expect(r.statusCode).toBe(201)
    expect(json<{ criadas: number }>(r).criadas).toBe(1)
  })
})

describe('Tarefas v2 — sem próximo passo', () => {
  it('só tarefa aberta FUTURA conta; atrasada e de outro contato não', async () => {
    await chamar(T, 'POST', '/v1/tarefas', { titulo: 'futura', venceEm: em(H), contatoId: C1 })
    await chamar(T, 'POST', '/v1/tarefas', { titulo: 'atrasada', venceEm: em(-H), contatoId: C2 })
    const r = json<{ itens: { contatoId: string; semProximoPasso: boolean }[] }>(await chamar(T, 'GET', `/v1/tarefas/sem-proximo-passo?contatoIds=${C1},${C2}`))
    expect(r.itens.find((i) => i.contatoId === C1)!.semProximoPasso).toBe(false)
    expect(r.itens.find((i) => i.contatoId === C2)!.semProximoPasso).toBe(true)
  })
  it('máximo de 200 ids e UUID válido', async () => {
    const muitos = Array.from({ length: 201 }, (_, i) => `fa5e0000-9999-4000-8000-${String(i).padStart(12, '0')}`).join(',')
    expect((await chamar(T, 'GET', `/v1/tarefas/sem-proximo-passo?contatoIds=${muitos}`)).statusCode).toBe(422)
    expect((await chamar(T, 'GET', '/v1/tarefas/sem-proximo-passo?contatoIds=abc')).statusCode).toBe(422)
  })
  it('isolamento: tarefa futura de outro tenant não conta', async () => {
    await chamar(OUTRO, 'POST', '/v1/tarefas', { titulo: 'x', venceEm: em(H), contatoId: CO })
    const r = json<{ itens: { semProximoPasso: boolean }[] }>(await chamar(T, 'GET', `/v1/tarefas/sem-proximo-passo?contatoIds=${CO}`))
    expect(r.itens[0]!.semProximoPasso).toBe(true)
  })
})
