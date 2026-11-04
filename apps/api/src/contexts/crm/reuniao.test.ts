import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { encerrarBanco } from '../../db/index.js'
import { pluginTenant } from '../../plugins/tenant.js'
import { rotasReuniao } from './rotas-reuniao.js'
import { rotasContatoFeed } from './rotas-contato-feed.js'

/**
 * REUNIÃO PELA CONVERSA (C3): vendedores na ordem (responsável primeiro, depois a filial),
 * horários livres (expediente do número − eventos), escopo por papel, 409 de concorrência,
 * troca de responsável com registro no feed, módulo desligado e dois tenants.
 * Banco real, papel da aplicação; UUIDs exclusivos deste arquivo (prefixo c3e0).
 */
const A = 'c3e00000-0000-4000-8000-00000000000a'
const B = 'c3e00000-0000-4000-8000-00000000000b'
const PLANO = 'c3e00000-0001-4000-8000-000000000001'
const MODELO = 'c3e00000-0002-4000-8000-000000000001'
const PV_A = 'c3e00000-0003-4000-8000-00000000000a'
const PV_B = 'c3e00000-0003-4000-8000-00000000000b'
const FX = 'c3e00000-0004-4000-8000-000000000001'
const FY = 'c3e00000-0004-4000-8000-000000000002'
const U = {
  adm: 'c3e00000-0005-4000-8000-000000000001',
  gx: 'c3e00000-0005-4000-8000-000000000002',
  va: 'c3e00000-0005-4000-8000-000000000003',
  vb: 'c3e00000-0005-4000-8000-000000000004',
  vy: 'c3e00000-0005-4000-8000-000000000005',
  bx: 'c3e00000-0005-4000-8000-000000000006',
}
const CA = 'c3e00000-0006-4000-8000-000000000001'
const CB = 'c3e00000-0006-4000-8000-000000000002'
const CT2 = 'c3e00000-0006-4000-8000-000000000003'
const CANAL = 'c3e00000-0007-4000-8000-000000000001'
const CANAL_B = 'c3e00000-0007-4000-8000-000000000002'
const CVA = 'c3e00000-0008-4000-8000-000000000001'
const CVB = 'c3e00000-0008-4000-8000-000000000002'
const CV_T2 = 'c3e00000-0008-4000-8000-000000000003'
const AT_B = 'c3e00000-0009-4000-8000-000000000001'

const sub = (k: keyof typeof U) => `c3e-sub-${k}`
const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance

async function pedir(quem: keyof typeof U, method: 'GET' | 'POST', url: string, payload?: unknown) {
  const tenant = quem === 'bx' ? B : A
  const r = await app.inject({
    method, url, headers: { 'x-tenant-id': tenant, 'x-teste-sub': sub(quem) }, ...(payload !== undefined ? { payload: payload as object } : {}),
  })
  return { status: r.statusCode, corpo: r.json() as Record<string, unknown> }
}

/** Um dia útil (terça) entre 8 e 14 dias à frente, no fuso do tenant (São Paulo, UTC−3). */
function proximaTerca(): string {
  const base = new Date(Date.now() - 3 * 3_600_000)
  for (let n = 8; n < 15; n++) {
    const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + n))
    if (d.getUTCDay() === 2) return d.toISOString().slice(0, 10)
  }
  throw new Error('sem terça')
}
const DIA = proximaTerca()
const SABADO = (() => { const d = new Date(`${DIA}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 4); return d.toISOString().slice(0, 10) })()
const as = (hora: string, dia = DIA) => new Date(`${dia}T${hora}:00-03:00`).toISOString()
const horaLocal = (iso: string) => new Date(new Date(iso).getTime() - 3 * 3_600_000).toISOString().slice(11, 16)

async function donoAtual(contato: string): Promise<string | null> {
  const [l] = await dono<{ usuario_id: string | null }[]>`
    SELECT usuario_id FROM carteira_atribuicao WHERE tenant_id = ${A} AND contato_id = ${contato} AND ate IS NULL`
  return l?.usuario_id ?? null
}

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-c3e', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-c3e', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[A, PV_A, 'Reunião A'], [B, PV_B, 'Reunião B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id, fuso) VALUES (${t}, ${nome}, ${PLANO}, ${pv}, 'America/Sao_Paulo') ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  // A com o módulo ligado; B desligado (sem linha = desligado).
  await dono`INSERT INTO tenant_modulo (tenant_id, modulo, ativo) VALUES (${A}, 'agenda', true) ON CONFLICT (tenant_id, modulo) DO UPDATE SET ativo = true`
  await dono`INSERT INTO filial (tenant_id, id, nome) VALUES (${A}, ${FX}, 'Filial X'), (${A}, ${FY}, 'Filial Y')`
  for (const k of Object.keys(U) as (keyof typeof U)[]) {
    await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email)
               VALUES (${k === 'bx' ? B : A}, ${U[k]}, ${sub(k)}, ${'Pessoa ' + k}, ${sub(k) + '@c3e.test'})`
  }
  const vinc = (u: string, f: string | null, p: string) => dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES (${A}, ${u}, ${f}, ${p})`
  await vinc(U.adm, null, 'admin'); await vinc(U.gx, FX, 'gestor')
  await vinc(U.va, FX, 'vendedor'); await vinc(U.vb, FX, 'vendedor'); await vinc(U.vy, FY, 'vendedor')

  await dono`INSERT INTO contato (tenant_id, id, nome) VALUES (${A}, ${CA}, 'Cliente Alfa'), (${A}, ${CB}, 'Cliente Beta'), (${B}, ${CT2}, 'Cliente de B')`
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES
    (${A}, ${CANAL}, 'whatsapp_oficial', 'Zap C3', 'conectado'), (${B}, ${CANAL_B}, 'whatsapp_oficial', 'Zap B', 'conectado')`
  // Expediente do número: dias úteis das 09:00 às 11:00 — a grade fica pequena e conferível.
  const faixa = { de: '09:00', ate: '11:00' }
  await dono`INSERT INTO canal_configuracao (tenant_id, canal_id, horario_atendimento)
             VALUES (${A}, ${CANAL}, ${JSON.stringify({ seg: faixa, ter: faixa, qua: faixa, qui: faixa, sex: faixa, sab: null, dom: null })}::text::jsonb)`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, ultima_direcao, ultima_mensagem_em) VALUES
    (${A}, ${CVA}, ${CANAL}, ${CA}, 'entrante', now()), (${A}, ${CVB}, ${CANAL}, ${CB}, 'entrante', now()),
    (${B}, ${CV_T2}, ${CANAL_B}, ${CT2}, 'entrante', now())`
  // Beta é de VB, mas está EM ATENDIMENTO com VA agora (VA a enxerga pelo escopo).
  await dono`INSERT INTO atendimento (tenant_id, id, conversa_id, canal_id, protocolo, estado, atendente_id)
             VALUES (${A}, ${AT_B}, ${CVB}, ${CANAL}, 91001, 'em_atendimento', ${U.va})`

  app = Fastify()
  await app.register(pluginTenant)
  app.addHook('onRequest', async (req) => {
    const s = req.headers['x-teste-sub']
    if (typeof s === 'string') { req.usuarioSub = s; req.usuarioEmail = `${s}@c3e.test` }
  })
  await app.register(rotasReuniao)
  await app.register(rotasContatoFeed)
  await app.ready()
})

beforeEach(async () => {
  await dono`DELETE FROM evento_agenda WHERE tenant_id IN (${A}, ${B})`
  await dono`DELETE FROM auditoria WHERE tenant_id IN (${A}, ${B})`
  await dono`DELETE FROM notificacao WHERE tenant_id IN (${A}, ${B})`
  await dono`DELETE FROM carteira_atribuicao WHERE tenant_id IN (${A}, ${B})`
  await dono`INSERT INTO carteira_atribuicao (tenant_id, id, contato_id, usuario_id) VALUES
    (${A}, gen_random_uuid(), ${CA}, ${U.va}), (${A}, gen_random_uuid(), ${CB}, ${U.vb})`
})

afterAll(async () => {
  for (const t of [A, B]) {
    await dono`DELETE FROM evento_agenda WHERE tenant_id = ${t}`
    await dono`DELETE FROM auditoria WHERE tenant_id = ${t}`
    await dono`DELETE FROM notificacao WHERE tenant_id = ${t}`
    await dono`DELETE FROM outbox WHERE tenant_id = ${t}`
    await dono`DELETE FROM atendimento WHERE tenant_id = ${t}`
    await dono`DELETE FROM conversa WHERE tenant_id = ${t}`
    await dono`DELETE FROM canal_configuracao WHERE tenant_id = ${t}`
    await dono`DELETE FROM canal_conectado WHERE tenant_id = ${t}`
    await dono`DELETE FROM carteira_atribuicao WHERE tenant_id = ${t}`
    await dono`DELETE FROM contato WHERE tenant_id = ${t}`
    await dono`DELETE FROM usuario_filial WHERE tenant_id = ${t}`
    await dono`DELETE FROM usuario WHERE tenant_id = ${t}`
    await dono`DELETE FROM filial WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant_modulo WHERE tenant_id = ${t}`
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

const livres = (quem: keyof typeof U, usuarioId: string, extra = '') =>
  pedir(quem, 'GET', `/v1/agenda/horarios-livres?usuarioId=${usuarioId}&dia=${DIA}${extra}`)
const marcar = (quem: keyof typeof U, corpo: Record<string, unknown>) =>
  pedir(quem, 'POST', '/v1/agenda/reunioes', { conversaId: CVA, duracaoMin: 30, ...corpo })

describe('Reunião — módulo desligado', () => {
  it('⚠️ as três rotas respondem 404 modulo.desligado', async () => {
    for (const [m, url, corpo] of [
      ['GET', `/v1/agenda/reuniao/vendedores?conversaId=${CV_T2}`],
      ['GET', `/v1/agenda/horarios-livres?usuarioId=${U.bx}&dia=${DIA}`],
      ['POST', '/v1/agenda/reunioes', { conversaId: CV_T2, usuarioId: U.bx, inicio: as('09:00') }],
    ] as const) {
      const r = await pedir('bx', m, url, corpo)
      expect(r.status, `${m} ${url}`).toBe(404)
      expect(r.corpo).toMatchObject({ erro: 'modulo.desligado' })
    }
  })
})

describe('Reunião — vendedores na ordem', () => {
  it('gestor da filial: responsável do contato primeiro, depois quem pede e a filial; outra filial fica de fora', async () => {
    const r = await pedir('gx', 'GET', `/v1/agenda/reuniao/vendedores?conversaId=${CVA}`)
    expect(r.status).toBe(200)
    const itens = r.corpo['itens'] as { usuarioId: string; responsavelDoContato: boolean }[]
    expect(itens[0]).toMatchObject({ usuarioId: U.va, responsavelDoContato: true })
    expect(itens.map((i) => i.usuarioId)).toEqual([U.va, U.gx, U.vb])
    expect(itens.some((i) => i.usuarioId === U.vy)).toBe(false)
  })

  it('vendedor: só ele (dono) — os colegas estão fora do escopo dele', async () => {
    const r = await pedir('va', 'GET', `/v1/agenda/reuniao/vendedores?conversaId=${CVA}`)
    expect((r.corpo['itens'] as { usuarioId: string }[]).map((i) => i.usuarioId)).toEqual([U.va])
  })

  it('vendedor atendendo cliente de outro: o dono do cliente primeiro, depois ele', async () => {
    const r = await pedir('va', 'GET', `/v1/agenda/reuniao/vendedores?conversaId=${CVB}`)
    expect((r.corpo['itens'] as { usuarioId: string }[]).map((i) => i.usuarioId)).toEqual([U.vb, U.va])
  })

  it('⚠️ conversa de outro tenant responde como inexistente', async () => {
    const r = await pedir('adm', 'GET', `/v1/agenda/reuniao/vendedores?conversaId=${CV_T2}`)
    expect(r.status).toBe(404)
    expect(r.corpo).toMatchObject({ erro: 'conversa.nao_encontrada' })
  })
})

describe('Reunião — horários livres', () => {
  it('expediente do número menos os eventos agendados da pessoa', async () => {
    await dono`INSERT INTO evento_agenda (tenant_id, id, titulo, responsavel_id, inicio, fim)
               VALUES (${A}, gen_random_uuid(), 'Ocupado', ${U.va}, ${as('09:30')}, ${as('10:00')})`
    // Evento CANCELADO não ocupa o horário.
    await dono`INSERT INTO evento_agenda (tenant_id, id, titulo, responsavel_id, inicio, fim, status)
               VALUES (${A}, gen_random_uuid(), 'Cancelado', ${U.va}, ${as('10:30')}, ${as('11:00')}, 'cancelado')`
    const r = await livres('va', U.va, `&conversaId=${CVA}`)
    expect(r.status).toBe(200)
    expect(r.corpo).toMatchObject({ origemExpediente: 'numero', fechado: false, duracaoMin: 30 })
    expect((r.corpo['horarios'] as { inicio: string }[]).map((h) => horaLocal(h.inicio))).toEqual(['09:00', '10:00', '10:30'])
  })

  it('sem conversa (sem número), vale o padrão comercial; sábado é dia fechado', async () => {
    const r = await livres('va', U.va)
    expect(r.corpo).toMatchObject({ origemExpediente: 'padrao', fechado: false })
    expect((r.corpo['horarios'] as unknown[]).length).toBe(18) // 09:00 … 17:30
    const s = await pedir('va', 'GET', `/v1/agenda/horarios-livres?usuarioId=${U.va}&dia=${SABADO}`)
    expect(s.corpo).toMatchObject({ fechado: true, horarios: [] })
  })

  it('duração muda a grade; duração e dia inválidos são 422', async () => {
    const r = await livres('va', U.va, `&conversaId=${CVA}&duracao=60`)
    expect((r.corpo['horarios'] as { inicio: string }[]).map((h) => horaLocal(h.inicio))).toEqual(['09:00', '09:30', '10:00'])
    expect((await livres('va', U.va, '&duracao=7')).status).toBe(422)
    expect((await pedir('va', 'GET', `/v1/agenda/horarios-livres?usuarioId=${U.va}&dia=2020-01-01`)).status).toBe(422)
  })

  it('⚠️ escopo: vendedor não consulta colega; consulta o dono do cliente que está atendendo; gestor só a filial dele', async () => {
    expect((await livres('va', U.vb)).status).toBe(403)
    expect((await livres('va', U.vb)).corpo).toMatchObject({ erro: 'agenda.responsavel_proibido' })
    expect((await livres('va', U.vb, `&conversaId=${CVB}`)).status).toBe(200)
    expect((await livres('gx', U.vb)).status).toBe(200)
    expect((await livres('gx', U.vy)).status).toBe(403)
    expect((await livres('adm', U.vy)).status).toBe(200)
  })
})

describe('Reunião — marcar pela conversa', () => {
  it('outro vendedor assume: vira responsável do contato, com registro no feed e aviso no sino', async () => {
    const r = await marcar('gx', { usuarioId: U.vb, inicio: as('10:00') })
    expect(r.status).toBe(201)
    expect(r.corpo).toMatchObject({ responsavelAlterado: true })
    expect(await donoAtual(CA)).toBe(U.vb)
    const [e] = await dono<{ origem: string; conversa_id: string; responsavel_id: string; status: string }[]>`
      SELECT origem, conversa_id, responsavel_id, status FROM evento_agenda WHERE tenant_id = ${A} AND id = ${r.corpo['eventoId'] as string}`
    expect(e).toMatchObject({ origem: 'conversa', conversa_id: CVA, responsavel_id: U.vb, status: 'agendado' })
    const feed = await pedir('gx', 'GET', `/v1/contatos/${CA}/feed`)
    const item = (feed.corpo['itens'] as { tipo: string; texto: string }[]).find((i) => i.tipo === 'reuniao')
    expect(item?.texto).toMatch(/^Reunião agendada com Pessoa vb para \d{2}\/\d{2} às 10:00\. Pessoa vb passou a ser responsável pelo contato$/)
    const [n] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM notificacao WHERE tenant_id = ${A} AND usuario_id = ${U.vb} AND tipo = 'agenda.reuniao'`
    expect(n?.n).toBe(1)
  })

  it('com o próprio responsável, o dono não muda', async () => {
    const r = await marcar('va', { usuarioId: U.va, inicio: as('09:00') })
    expect(r.status).toBe(201)
    expect(r.corpo).toMatchObject({ responsavelAlterado: false })
    expect(await donoAtual(CA)).toBe(U.va)
  })

  it('⚠️ 409 tipificado quando duas pessoas marcam o mesmo horário ao mesmo tempo', async () => {
    const [x, y] = await Promise.all([
      marcar('gx', { usuarioId: U.va, inicio: as('10:30') }),
      marcar('adm', { usuarioId: U.va, inicio: as('10:30'), conversaId: CVB }),
    ])
    expect([x.status, y.status].sort()).toEqual([201, 409])
    const perdeu = x.status === 409 ? x : y
    expect(perdeu.corpo).toMatchObject({ erro: 'agenda.horario_ocupado' })
    expect(perdeu.corpo['conflito']).toBeTruthy()
    const [n] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM evento_agenda WHERE tenant_id = ${A} AND responsavel_id = ${U.va}`
    expect(n?.n).toBe(1)
  })

  it('⚠️ escopo: vendedor não marca com colega; conversa fora do escopo é 404', async () => {
    const r = await marcar('va', { usuarioId: U.vb, inicio: as('10:00') })
    expect(r.status).toBe(403)
    expect(r.corpo).toMatchObject({ erro: 'agenda.responsavel_proibido' })
    expect((await marcar('vy', { usuarioId: U.vy, inicio: as('10:00') })).status).toBe(404)
    expect((await marcar('adm', { usuarioId: U.va, inicio: as('10:00'), conversaId: CV_T2 })).status).toBe(404)
  })

  it('horário que já passou e corpo inválido são 422', async () => {
    expect((await marcar('adm', { usuarioId: U.va, inicio: new Date(Date.now() - 3_600_000).toISOString() })).corpo)
      .toMatchObject({ erro: 'agenda.horario_passado' })
    expect((await marcar('adm', { usuarioId: U.va, inicio: 'amanhã' })).status).toBe(422)
    expect((await marcar('adm', { usuarioId: U.va, inicio: as('10:00'), duracaoMin: 7 })).status).toBe(422)
    expect((await marcar('adm', { usuarioId: U.va, inicio: as('10:00'), link: 'javascript:x' })).status).toBe(422)
  })
})
