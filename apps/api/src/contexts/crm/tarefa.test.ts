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
  await dono`DELETE FROM auditoria WHERE tenant_id IN (${T}, ${OUTRO}) AND acao LIKE 'tarefa.%'`
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

describe('Tarefas v2 — revisão adversarial (validação, cursor, responsável nulo, autorização)', () => {
  const ADMIN_FIXO = 'fa5e0000-6666-4000-8000-000000000001'
  const COLEGA = 'fa5e0000-6666-4000-8000-000000000002'
  const papelDe = (u: string, p: string) =>
    dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES (${T}, ${u}, NULL, ${p})
         ON CONFLICT (tenant_id, usuario_id) WHERE filial_id IS NULL DO UPDATE SET papel = EXCLUDED.papel`

  let eu = ''
  beforeEach(async () => {
    await dono`DELETE FROM usuario_filial WHERE tenant_id = ${T}`
    await dono`DELETE FROM auditoria WHERE tenant_id = ${T} AND acao LIKE 'tarefa.%'`
    await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${T}, ${ADMIN_FIXO}, 'sub-admin-c1b', 'Ada', 'ada@c1b.test') ON CONFLICT DO NOTHING`
    await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${T}, ${COLEGA}, 'sub-colega-c1b', 'Cola', 'cola@c1b.test') ON CONFLICT DO NOTHING`
    await papelDe(ADMIN_FIXO, 'admin') // leaves the founder mode: the dev user has no role until a test grants one
    await criar(T, em(H), 'semente') // creates the dev user row
    const [u] = await dono<{ id: string }[]>`SELECT id FROM usuario WHERE tenant_id=${T} AND cognito_sub=${'dev-' + T}`
    eu = u!.id
    await dono`DELETE FROM tarefa WHERE tenant_id = ${T}`
  })
  const inserir = async (titulo: string, venceEm: string, extra: { resp?: string | null; criador?: string | null } = {}) => {
    const [r] = await dono<{ id: string }[]>`
      INSERT INTO tarefa (tenant_id, id, titulo, vence_em, responsavel_id, criado_por)
      VALUES (${T}, gen_random_uuid(), ${titulo}, ${venceEm}::text::timestamptz, ${extra.resp ?? null}, ${extra.criador ?? null}) RETURNING id`
    return r!.id
  }
  const lista = async (qs: string) => json<Lista>(await chamar(T, 'GET', `/v1/tarefas?${qs}`)).itens.map((i) => i.titulo)

  it('situacao=hoje é só o dia local: tarefa de ontem aberta fica em atrasadas', async () => {
    const [l] = await dono<{ ini: Date }[]>`
      SELECT date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo' AS ini`
    const ini = l!.ini.getTime()
    await criar(T, new Date(ini - 3600_000).toISOString(), 'ontem')
    await criar(T, new Date(ini + 60_000).toISOString(), 'hoje cedo')
    expect(await lista('situacao=hoje')).toEqual(['hoje cedo'])
    expect(await lista('situacao=atrasadas')).toContain('ontem')
  })

  it('POST valida contato e responsável (422 por campo, nunca 500)', async () => {
    const base = { titulo: 'x', venceEm: em(H) }
    for (const [corpo, campo] of [
      [{ ...base, contatoId: 'nao-uuid' }, 'contatoId'],
      [{ ...base, contatoId: 'fa5e0000-7777-4000-8000-000000000001' }, 'contatoId'], // well-formed, not found
      [{ ...base, contatoId: CO }, 'contatoId'], // another tenant's contact
      [{ ...base, responsavelId: 'nao-uuid' }, 'responsavelId'],
      [{ ...base, responsavelId: 'fa5e0000-7777-4000-8000-000000000002' }, 'responsavelId'],
    ] as const) {
      const r = await chamar(T, 'POST', '/v1/tarefas', corpo)
      expect(r.statusCode).toBe(422)
      expect(json<{ campos: string[] }>(r).campos).toContain(campo)
    }
    expect((await dono`SELECT 1 FROM tarefa WHERE tenant_id=${T}`).length).toBe(0)
  })

  it('entradas inválidas → 422 (corpo e consulta)', async () => {
    const post = (c: Record<string, unknown>) => chamar(T, 'POST', '/v1/tarefas', { titulo: 'x', venceEm: em(H), ...c })
    expect((await post({ venceEm: '2026-02-31T10:00:00Z' })).statusCode).toBe(422)
    expect((await post({ venceEm: '2026-02-10' })).statusCode).toBe(422) // no time/zone
    expect((await post({ venceEm: 'amanhã' })).statusCode).toBe(422)
    expect((await post({ venceEm: 123 })).statusCode).toBe(422)
    expect((await post({ titulo: 42 })).statusCode).toBe(422)
    expect((await post({ descricao: 'd'.repeat(5001) })).statusCode).toBe(422)
    expect((await post({ venceEm: '2030-06-01T10:00:00-03:00' })).statusCode).toBe(201)
    for (const qs of ['de=2026-02-31', 'ate=2026-13-01', 'de=ontem', 'situacao=xyz', 'tipo=fax',
      'contatoId=abc', 'responsavelId=abc', `q=${'a'.repeat(201)}`, 'tipo=ligacao&tipo=email']) {
      expect((await chamar(T, 'GET', `/v1/tarefas?${qs}`)).statusCode, qs).toBe(422)
    }
    expect((await chamar(T, 'GET', '/v1/tarefas/contadores?responsavelId=abc')).statusCode).toBe(422)
  })

  it('cursor malformado → 422', async () => {
    const b64 = (t: string) => Buffer.from(t).toString('base64url')
    for (const c of ['abc', b64('sem-separador'), b64('2026-01-01§x'), b64(`ontem§${C1}`),
      b64(`2026-02-31T10:00:00.000000Z§${C1}`), b64(`2026-01-01T25:00:00.000000Z§${C1}`),
      b64(`2026-01-01T10:00:00.000000Z§${C1}§extra`)]) {
      const r = await chamar(T, 'GET', `/v1/tarefas?cursor=${c}`)
      expect(r.statusCode, c).toBe(422)
      expect(json<{ erro: string }>(r).erro).toBe('cursor.invalido')
    }
  })

  it(':id que não é UUID → 404; resultado inválido → 422; lote com entrada inválida → 422', async () => {
    expect((await chamar(T, 'POST', '/v1/tarefas/nao-uuid/concluir')).statusCode).toBe(404)
    expect((await chamar(T, 'POST', '/v1/tarefas/nao-uuid/cancelar')).statusCode).toBe(404)
    expect((await chamar(T, 'POST', '/v1/tarefas/fa5e0000-7777-4000-8000-000000000003/concluir')).statusCode).toBe(404)
    const id = await inserir('A', em(H), { resp: eu })
    expect((await chamar(T, 'POST', `/v1/tarefas/${id}/concluir`, { resultado: 42 })).statusCode).toBe(422)
    expect((await chamar(T, 'POST', `/v1/tarefas/${id}/concluir`, { resultado: 'x'.repeat(2001) })).statusCode).toBe(422)
    await papelDe(eu, 'gestor')
    const lote = (c: Record<string, unknown>) => chamar(T, 'POST', '/v1/tarefas/lote', { titulo: 'x', venceEm: em(H), ...c })
    expect((await lote({ contatoIds: 'abc' })).statusCode).toBe(422)
    expect((await lote({ contatoIds: [1, 2] })).statusCode).toBe(422)
    expect((await lote({ contatoIds: [C1], venceEm: '2026-02-31T10:00:00Z' })).statusCode).toBe(422)
    expect((await lote({ contatoIds: [C1], tipo: 'fax' })).statusCode).toBe(422)
    expect((await dono`SELECT 1 FROM tarefa WHERE tenant_id=${T} AND id <> ${id}`).length).toBe(0)
  })

  it('cursor preserva microssegundos: tarefas que diferem só em µs na fronteira da página', async () => {
    for (let i = 0; i < 29; i++) await inserir(`T${i}`, `2030-01-01T09:00:${String(i).padStart(2, '0')}Z`, { resp: eu })
    await inserir('T29', '2030-01-01T10:00:00.000100Z', { resp: eu }) // last of page 1
    await inserir('T30', '2030-01-01T10:00:00.000200Z', { resp: eu }) // first of page 2 (same millisecond)
    await inserir('T31', '2030-01-01T10:00:00.000200Z', { resp: eu }) // same instant, tie broken by id
    const p1 = json<Lista>(await chamar(T, 'GET', '/v1/tarefas?situacao=abertas'))
    expect(p1.itens.length).toBe(30)
    expect(p1.itens[29]!.titulo).toBe('T29')
    const p2 = json<Lista>(await chamar(T, 'GET', `/v1/tarefas?situacao=abertas&cursor=${p1.proximoCursor}`))
    expect(p2.itens.map((i) => i.titulo).sort()).toEqual(['T30', 'T31']) // T29 not repeated, none skipped
    expect(p2.proximoCursor).toBeNull()
  })

  it('cursor atravessa um empate exato de vence_em sem perder nem repetir', async () => {
    for (let i = 0; i < 31; i++) await inserir(`E${i}`, '2030-02-02T10:00:00.123456Z', { resp: eu })
    const p1 = json<Lista>(await chamar(T, 'GET', '/v1/tarefas?situacao=abertas'))
    const p2 = json<Lista>(await chamar(T, 'GET', `/v1/tarefas?situacao=abertas&cursor=${p1.proximoCursor}`))
    const todos = [...p1.itens, ...p2.itens].map((i) => i.titulo)
    expect(todos.length).toBe(31)
    expect(new Set(todos).size).toBe(31)
  })

  it('responsável NULL ("de ninguém") aparece no filtro e nos contadores por responsável', async () => {
    await inserir('minha', em(H), { resp: eu })
    await inserir('de ninguém', em(H))
    await inserir('da colega', em(H), { resp: COLEGA })
    expect((await lista(`responsavelId=${eu}`)).sort()).toEqual(['de ninguém', 'minha'])
    const c = json<{ pendentes: number }>(await chamar(T, 'GET', `/v1/tarefas/contadores?responsavelId=${eu}`))
    expect(c.pendentes).toBe(2)
    expect(json<{ pendentes: number }>(await chamar(T, 'GET', '/v1/tarefas/contadores')).pendentes).toBe(3)
  })

  it('lote exige gestor/supervisor/admin', async () => {
    const corpo = { contatoIds: [C1], titulo: 'x', venceEm: em(H) }
    for (const papel of ['vendedor', 'atendente']) {
      await papelDe(eu, papel)
      expect((await chamar(T, 'POST', '/v1/tarefas/lote', corpo)).statusCode, papel).toBe(403)
    }
    await dono`DELETE FROM usuario_filial WHERE tenant_id=${T} AND usuario_id=${eu}`
    expect((await chamar(T, 'POST', '/v1/tarefas/lote', corpo)).statusCode).toBe(403) // no role at all
    for (const papel of ['gestor', 'supervisor', 'admin']) {
      await papelDe(eu, papel)
      expect((await chamar(T, 'POST', '/v1/tarefas/lote', corpo)).statusCode, papel).toBe(201)
    }
  })

  it('concluir/cancelar: responsável, criador ou gestão; os demais levam 403', async () => {
    const dosOutros = () => inserir('alheia', em(H), { resp: COLEGA, criador: COLEGA })
    for (const acao of ['concluir', 'cancelar']) {
      const alheia = await dosOutros()
      expect((await chamar(T, 'POST', `/v1/tarefas/${alheia}/${acao}`)).statusCode, `${acao} sem papel`).toBe(403)
      await papelDe(eu, 'vendedor')
      expect((await chamar(T, 'POST', `/v1/tarefas/${alheia}/${acao}`)).statusCode, `${acao} vendedor`).toBe(403)
      expect((await dono`SELECT 1 FROM tarefa WHERE id=${alheia} AND estado='aberta'`).length).toBe(1)
      const minha = await inserir('minha', em(H), { resp: eu, criador: COLEGA })
      expect((await chamar(T, 'POST', `/v1/tarefas/${minha}/${acao}`)).statusCode, `${acao} responsável`).toBe(200)
      const criada = await inserir('criei', em(H), { resp: COLEGA, criador: eu })
      expect((await chamar(T, 'POST', `/v1/tarefas/${criada}/${acao}`)).statusCode, `${acao} criador`).toBe(200)
      const nula = await inserir('de ninguém', em(H), { criador: COLEGA })
      expect((await chamar(T, 'POST', `/v1/tarefas/${nula}/${acao}`)).statusCode, `${acao} tarefa sem dono`).toBe(403)
      await papelDe(eu, 'gestor')
      expect((await chamar(T, 'POST', `/v1/tarefas/${alheia}/${acao}`)).statusCode, `${acao} gestor`).toBe(200)
      expect((await chamar(T, 'POST', `/v1/tarefas/${nula}/${acao}`)).statusCode, `${acao} gestor sem dono`).toBe(200)
      await papelDe(eu, 'supervisor')
      const outra = await dosOutros()
      expect((await chamar(T, 'POST', `/v1/tarefas/${outra}/${acao}`)).statusCode, `${acao} supervisor`).toBe(200)
      await dono`DELETE FROM usuario_filial WHERE tenant_id=${T} AND usuario_id=${eu}`
    }
  })

  it('concluir e cancelar são auditados, com autor e id da tarefa', async () => {
    const a = await inserir('a', em(H), { resp: eu })
    const b = await inserir('b', em(H), { resp: eu })
    await chamar(T, 'POST', `/v1/tarefas/${a}/concluir`)
    await chamar(T, 'POST', `/v1/tarefas/${b}/cancelar`)
    const aud = await dono<{ acao: string; entidade_id: string; ator_id: string }[]>`
      SELECT acao, entidade_id, ator_id FROM auditoria WHERE tenant_id=${T} AND acao LIKE 'tarefa.%' AND acao <> 'tarefa.lote'`
    expect(aud.map((x) => x.acao).sort()).toEqual(['tarefa.cancelada', 'tarefa.concluida'])
    expect(aud.find((x) => x.acao === 'tarefa.cancelada')).toMatchObject({ entidade_id: b, ator_id: eu })
    expect(aud.find((x) => x.acao === 'tarefa.concluida')).toMatchObject({ entidade_id: a, ator_id: eu })
  })
})
