import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import type { RespostaCockpit, RespostaItensCockpit } from '@geracrm/shared'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'
import { instanteLocal, partesLocais } from '../atendimento/expediente.js'

/**
 * D1 — cockpit do gestor. Quatro tenants (cada um é um papel/escopo, porque o chamador do modo dev é
 * sempre `dev-<tenant>`): T = gestor de tudo; TF = gestor da filial X; TV = vendedor (403); T2 = vizinho.
 */
const T = 'd1d00000-0000-4000-8000-000000000001'
const TF = 'd1d00000-0000-4000-8000-000000000002'
const TV = 'd1d00000-0000-4000-8000-000000000003'
const T2 = 'd1d00000-0000-4000-8000-000000000004'
const TENANTS = [T, TF, TV, T2]
const PLANO = 'd1d00000-3333-4000-8000-000000000001'
const MODELO = 'd1d00000-4444-4000-8000-000000000001'
const id = (n: number, g = 6) => `d1d00000-${g}${g}${g}${g}-4000-8000-${String(n).padStart(12, '0')}`
const EU = id(1); const ADM = id(2); const V1 = id(3); const V2 = id(4)
const EU_F = id(11); const ADM_F = id(12); const VX = id(13); const VY = id(14)
const EU_V = id(21); const ADM_V = id(22)
const EU_2 = id(31)
const FX = id(1, 7); const FY = id(2, 7)
const CANAL = id(1, 5); const CANAL_X = id(2, 5); const CANAL_Y = id(3, 5); const CANAL_V = id(4, 5); const CANAL_2 = id(5, 5)
const BULK = 22

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const get = (url: string, tenant = T) => app.inject({ method: 'GET', url, headers: { 'x-tenant-id': tenant } })
const cockpit = async (q = '', tenant = T) => (await get(`/v1/gestao/cockpit${q}`, tenant)).json() as RespostaCockpit
const itens = async (q: string, tenant = T) => (await get(`/v1/gestao/cockpit/itens?${q}`, tenant)).json() as RespostaItensCockpit

const agora = new Date()
const min = 60_000
const dia = 86_400_000
const fuso = 'America/Sao_Paulo'
const hojeIni = instanteLocal(partesLocais(agora, fuso).data, '00:00', fuso)
/** Instante de HOJE e já passado, em qualquer hora do dia (ponto médio entre 00:00 local e agora). */
const hojePassado = new Date(hojeIni.getTime() + Math.floor((agora.getTime() - hojeIni.getTime()) / 2))

async function contato(t: string, nome: string, o: { qualificado?: boolean; criado?: Date; dono?: string; filial?: string } = {}) {
  const c = randomUUID()
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo, qualificado, qualificado_em, criado_em, filial_id)
             VALUES (${t}, ${c}, ${nome}, 'teste', true, ${o.qualificado ?? null}, ${o.qualificado ? new Date() : null}, ${o.criado ?? new Date()}, ${o.filial ?? null})`
  if (o.dono) await dono`INSERT INTO carteira_atribuicao (tenant_id, id, contato_id, usuario_id) VALUES (${t}, ${randomUUID()}, ${c}, ${o.dono})`
  return c
}

/** Conversa em que o cliente falou por último; `sla` arma um handoff na fila. */
async function conversa(t: string, canal: string, nome: string, sla?: { resp: string; inicio: Date; vence: Date }, filial?: string) {
  const c = await contato(t, nome, filial ? { filial } : {})
  const cv = randomUUID()
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao, ultima_direcao, ultima_mensagem_em, ultima_entrante_em)
             VALUES (${t}, ${cv}, ${canal}, ${c}, 0, 'entrante', now(), now())`
  if (sla) {
    await dono`INSERT INTO atendimento (tenant_id, id, conversa_id, canal_id, protocolo, estado, responsavel_id, sla_inicio_em, sla_vence_em)
               VALUES (${t}, ${randomUUID()}, ${cv}, ${canal}, proximo_numero(${t}, 'protocolo'), 'na_fila', ${sla.resp}, ${sla.inicio}, ${sla.vence})`
  }
  return { cv, c }
}

async function oportunidade(t: string, contatoId: string, etapa: string, resp: string | null) {
  await dono`INSERT INTO oportunidade (tenant_id, id, contato_id, etapa_id, responsavel_id)
             VALUES (${t}, ${randomUUID()}, ${contatoId}, ${etapa}, ${resp})`
}

async function evento(t: string, resp: string, inicio: Date, status: string, contatoId: string | null = null) {
  await dono`INSERT INTO evento_agenda (tenant_id, id, titulo, contato_id, responsavel_id, inicio, fim, status)
             VALUES (${t}, ${randomUUID()}, 'Reunião D1', ${contatoId}, ${resp}, ${inicio}, ${new Date(inicio.getTime() + 30 * min)}, ${status})`
}

async function papel(t: string, u: string, p: string, filial: string | null = null) {
  await dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES (${t}, ${u}, ${filial}, ${p})`
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-d1', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-d1', 'Varejo') ON CONFLICT DO NOTHING`
  for (const t of TENANTS) {
    const pv = id(Number(t.slice(-1)), 8)
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${`Loja D1 ${t.slice(-1)}`}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  for (const [t, c] of [[T, CANAL], [TF, CANAL_X], [TF, CANAL_Y], [TV, CANAL_V], [T2, CANAL_2]] as const) {
    await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado)
               VALUES (${t}, ${c}, 'whatsapp_nao_oficial', 'plugzapi', 'Canal D1', 'conectado')`
  }
  for (const [t, f, nome] of [[TF, FX, 'Filial X'], [TF, FY, 'Filial Y']] as const) {
    await dono`INSERT INTO filial (tenant_id, id, nome) VALUES (${t}, ${f}, ${nome})`
  }
  await dono`UPDATE canal_conectado SET filial_id = ${FX} WHERE tenant_id = ${TF} AND id = ${CANAL_X}`
  await dono`UPDATE canal_conectado SET filial_id = ${FY} WHERE tenant_id = ${TF} AND id = ${CANAL_Y}`
  for (const [t, u, sub, nome] of [
    [T, EU, `dev-${T}`, 'Eu'], [T, ADM, 'sub-adm-d1', 'Ada'], [T, V1, 'sub-v1-d1', 'Vera'], [T, V2, 'sub-v2-d1', 'Caio'],
    [TF, EU_F, `dev-${TF}`, 'Eu F'], [TF, ADM_F, 'sub-adm-f-d1', 'Ada F'], [TF, VX, 'sub-vx-d1', 'Vendedor X'], [TF, VY, 'sub-vy-d1', 'Vendedor Y'],
    [TV, EU_V, `dev-${TV}`, 'Eu V'], [TV, ADM_V, 'sub-adm-v-d1', 'Ada V'], [T2, EU_2, `dev-${T2}`, 'Eu 2'],
  ] as const) {
    await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${t}, ${u}, ${sub}, ${nome}, ${`${sub}@d1.test`})`
  }
  await papel(T, ADM, 'admin'); await papel(T, EU, 'gestor'); await papel(T, V1, 'vendedor'); await papel(T, V2, 'vendedor')
  await papel(TF, ADM_F, 'admin'); await papel(TF, EU_F, 'gestor', FX); await papel(TF, VX, 'vendedor', FX); await papel(TF, VY, 'vendedor', FY)
  await papel(TV, ADM_V, 'admin'); await papel(TV, EU_V, 'vendedor')
  for (const t of [T, TF, TV, T2]) {
    await dono`INSERT INTO funil_etapa (tenant_id, id, ordem, chave, nome, tipo) VALUES
      (${t}, ${randomUUID()}, 1, 'lead', 'Lead', 'aberto') ON CONFLICT (tenant_id, chave) DO NOTHING`
  }

  // ── T: fila e SLA ──
  await conversa(T, CANAL, 'A sem handoff')
  await conversa(T, CANAL, 'B atenção', { resp: V1, inicio: new Date(agora.getTime() - 50 * min), vence: new Date(agora.getTime() + 10 * min) })
  await conversa(T, CANAL, 'C ok', { resp: V2, inicio: new Date(agora.getTime() - 5 * min), vence: new Date(agora.getTime() + 25 * min) })
  await conversa(T, CANAL, 'D estourado hoje', { resp: V1, inicio: new Date(hojePassado.getTime() - 30 * min), vence: hojePassado })
  await conversa(T, CANAL, 'E estourado ontem', { resp: V1, inicio: new Date(hojeIni.getTime() - 3 * 60 * min), vence: new Date(hojeIni.getTime() - 2 * 60 * min) })
  // ── T: esquecidos e sem próximo passo ──
  const velho = new Date(agora.getTime() - 30 * dia)
  await contato(T, 'Q1 qualificado velho', { qualificado: true, criado: velho, dono: V1 })
  const q2 = await contato(T, 'Q2 qualificado recente', { qualificado: true, criado: velho })
  const cvQ2 = randomUUID()
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao, ultima_direcao, ultima_mensagem_em)
             VALUES (${T}, ${cvQ2}, ${CANAL}, ${q2}, 0, 'saliente', ${new Date(agora.getTime() - dia)})`
  const [etapa] = await dono<{ id: string }[]>`SELECT id FROM funil_etapa WHERE tenant_id = ${T} AND chave = 'lead'`
  const q3 = await contato(T, 'Q3 em funil sem passo', { criado: new Date(agora.getTime() - 10 * dia) })
  await oportunidade(T, q3, etapa!.id, V2)
  const o2 = await contato(T, 'O2 com tarefa futura', { criado: agora })
  await oportunidade(T, o2, etapa!.id, V2)
  await dono`INSERT INTO tarefa (tenant_id, id, contato_id, responsavel_id, titulo, vence_em) VALUES (${T}, ${randomUUID()}, ${o2}, ${V2}, 'Ligar', ${new Date(agora.getTime() + dia)})`
  const o3 = await contato(T, 'O3 com reunião futura', { criado: agora })
  await oportunidade(T, o3, etapa!.id, V2)
  await evento(T, V2, new Date(agora.getTime() + 2 * dia), 'agendado', o3)
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo, qualificado, qualificado_em, criado_em)
             SELECT ${T}, gen_random_uuid(), 'Bulk ' || g, 'teste', true, true, now(), ${velho} FROM generate_series(1, ${BULK}) g`
  // ── T: agenda de hoje (módulo desligado por padrão) ──
  await evento(T, V1, hojeIni, 'agendado'); await evento(T, V1, hojeIni, 'nao_compareceu')
  await evento(T, V2, hojeIni, 'cancelado'); await evento(T, V2, new Date(hojeIni.getTime() + dia + min), 'agendado')

  // ── TF: duas filiais ──
  // A fila de um número visível a quem o atende: o número Y é atendido só pelo VY (senão "ninguém vinculado" = todos atendem).
  await dono`INSERT INTO usuario_canal (tenant_id, usuario_id, canal_id) VALUES (${TF}, ${VY}, ${CANAL_Y})`
  await conversa(TF, CANAL_X, 'Fila X', undefined, FX); await conversa(TF, CANAL_Y, 'Fila Y', undefined, FY)
  await contato(TF, 'CX velho', { qualificado: true, criado: velho, dono: VX })
  await contato(TF, 'CY velho', { qualificado: true, criado: velho, dono: VY })
  // ── T2: um esquecido só ──
  await contato(T2, 'Só do vizinho', { qualificado: true, criado: velho })
  await conversa(T2, CANAL_2, 'Fila do vizinho')
  app = await criarApp(); await app.ready()
})

afterAll(async () => {
  const ids = TENANTS.map((t) => `'${t}'`).join(',')
  for (const t of ['evento_agenda', 'tenant_modulo', 'tarefa', 'oportunidade', 'mensagem', 'atendimento', 'conversa', 'carteira_atribuicao', 'contato',
    'funil_etapa', 'usuario_canal', 'usuario_filial', 'usuario', 'canal_conectado', 'filial', 'outbox', 'auditoria']) {
    await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id IN (${ids})`)
  }
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id IN ${dono(TENANTS)}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id IN ${dono(TENANTS)}`
  await dono`DELETE FROM tenant WHERE id IN ${dono(TENANTS)}`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('GET /v1/gestao/cockpit — módulo agenda desligado', () => {
  it('aguardando humano por faixa: sem handoff e no prazo = ok, 2/3 do prazo = atenção, vencido = estourado', async () => {
    const r = await cockpit()
    expect(r.cards.aguardandoHumano).toEqual({ total: 5, porFaixa: { ok: 2, atencao: 1, estourado: 2 } })
  })
  it('SLA estourado hoje conta só o que venceu HOJE no fuso do tenant (o de ontem não)', async () => {
    expect((await cockpit()).cards.slaEstouradoHoje).toBe(1)
  })
  it('esquecidos: qualificado ou em funil sem toque há mais de N dias; mensagem recente tira da lista', async () => {
    expect((await cockpit()).cards.esquecidos).toBe(2 + BULK) // Q1, Q3 e o lote; Q2 teve mensagem ontem
    expect((await cockpit('?dias=20')).cards.esquecidos).toBe(1 + BULK) // Q3 tem 10 dias
    expect((await cockpit('?dias=60')).cards.esquecidos).toBe(0)
  })
  it('sem próximo passo: em funil sem tarefa futura; a reunião futura NÃO conta enquanto a Agenda está desligada', async () => {
    expect((await cockpit()).cards.semProximoPasso).toBe(2) // Q3 e O3
  })
  it('cards de agenda vêm null e a lista responde 404 modulo.desligado', async () => {
    const r = await cockpit()
    expect(r.cards.reunioesHoje).toBeNull(); expect(r.cards.naoCompareceuHoje).toBeNull()
    expect(r.grupos.every((g) => g.reunioesHoje === null && g.naoCompareceuHoje === null)).toBe(true)
    const l = await get('/v1/gestao/cockpit/itens?card=reunioesHoje')
    expect(l.statusCode).toBe(404); expect(l.json()).toMatchObject({ erro: 'modulo.desligado' })
  })
  it('parâmetros inválidos → 422 tipificado', async () => {
    expect((await get('/v1/gestao/cockpit?agrupar=praca')).statusCode).toBe(422)
    expect((await get('/v1/gestao/cockpit?dias=0')).statusCode).toBe(422)
    expect((await get('/v1/gestao/cockpit/itens?card=x')).statusCode).toBe(422)
    expect((await get('/v1/gestao/cockpit/itens?card=esquecidos&cursor=lixo')).statusCode).toBe(422)
    expect((await get('/v1/gestao/cockpit/itens?card=esquecidos&grupo=nao-uuid')).statusCode).toBe(422)
  })
})

describe('agrupamento e itens', () => {
  it('por vendedor: cada responsável com os seus números; sem responsável vai para "sem"', async () => {
    const r = await cockpit('?agrupar=vendedor')
    const g = (k: string) => r.grupos.find((x) => x.chave === k)!
    expect(g(V1)).toMatchObject({ rotulo: 'Vera', aguardandoHumano: 3, slaEstouradoHoje: 1 })
    expect(g(V2)).toMatchObject({ rotulo: 'Caio', aguardandoHumano: 1, semProximoPasso: 2 })
    expect(g('sem')).toMatchObject({ rotulo: 'Sem responsável', aguardandoHumano: 1 })
    expect(r.grupos[r.grupos.length - 1]!.chave).toBe('sem')
    expect(r.grupos.reduce((s, x) => s + x.esquecidos, 0)).toBe(r.cards.esquecidos)
  })
  it('itens do card, filtrados por grupo e por faixa, com o necessário para agir', async () => {
    const todos = await itens(`card=aguardandoHumano&agrupar=vendedor&grupo=${V1}`)
    expect(todos.itens).toHaveLength(3)
    expect(todos.itens.map((i) => i.faixa).sort()).toEqual(['atencao', 'estourado', 'estourado'])
    expect(todos.itens[0]).toMatchObject({ tipo: 'conversa', responsavel: 'Vera' })
    expect(todos.itens[0]!.conversaId).toBeTruthy()
    const so = await itens('card=aguardandoHumano&faixa=atencao')
    expect(so.itens.map((i) => i.rotulo)).toEqual(['B atenção'])
    const sem = await itens('card=aguardandoHumano&grupo=sem')
    expect(sem.itens.map((i) => i.rotulo)).toEqual(['A sem handoff'])
  })
  it('esquecidos por cursor: 20 por página, sem repetir nem perder, e a ficha como link', async () => {
    const vistos: string[] = []
    let cursor: string | null = null
    let paginas = 0
    do {
      const p: RespostaItensCockpit = await itens(`card=esquecidos${cursor ? `&cursor=${cursor}` : ''}`)
      expect(p.itens.length).toBeLessThanOrEqual(20)
      for (const i of p.itens) { vistos.push(i.id); expect(i.link).toBe(`/contato/${i.contatoId}`) }
      cursor = p.proximoCursor
      paginas++
    } while (cursor)
    expect(paginas).toBe(2)
    expect(vistos).toHaveLength(2 + BULK)
    expect(new Set(vistos).size).toBe(vistos.length)
  })
  it('SLA estourado hoje lista só o de hoje', async () => {
    const r = await itens('card=slaEstouradoHoje')
    expect(r.itens.map((i) => i.rotulo)).toEqual(['D estourado hoje'])
  })
})

describe('módulo agenda ligado', () => {
  beforeAll(async () => {
    await dono`INSERT INTO tenant_modulo (tenant_id, modulo, ativo) VALUES (${T}, 'agenda', true)
               ON CONFLICT (tenant_id, modulo) DO UPDATE SET ativo = true`
  })
  it('reuniões de hoje (sem cancelada e sem a de amanhã) e não compareceu', async () => {
    const r = await cockpit()
    expect(r.cards.reunioesHoje).toBe(2)
    expect(r.cards.naoCompareceuHoje).toBe(1)
    expect(r.grupos.find((g) => g.chave === V1)).toMatchObject({ reunioesHoje: 2, naoCompareceuHoje: 1 })
  })
  it('a reunião futura passa a contar como próximo passo', async () => {
    expect((await cockpit()).cards.semProximoPasso).toBe(1) // só Q3
  })
  it('itens de agenda trazem status e versão para as ações rápidas', async () => {
    const r = await itens('card=naoCompareceuHoje')
    expect(r.itens).toHaveLength(1)
    expect(r.itens[0]).toMatchObject({ tipo: 'evento', eventoStatus: 'nao_compareceu', eventoVersao: 1, link: '/agenda' })
  })
})

describe('escopo e isolamento', () => {
  it('vendedor → 403 nas duas rotas', async () => {
    expect((await get('/v1/gestao/cockpit', TV)).statusCode).toBe(403)
    expect((await get('/v1/gestao/cockpit/itens?card=esquecidos', TV)).statusCode).toBe(403)
  })
  it('gestor da filial X não vê a filial Y (conversa, contato e grupos)', async () => {
    const r = await cockpit('?agrupar=vendedor', TF)
    expect(r.cards.aguardandoHumano.total).toBe(1)
    expect(r.cards.esquecidos).toBe(1)
    expect(r.grupos.map((g) => g.chave)).not.toContain(VY)
    const l = await itens('card=esquecidos', TF)
    expect(l.itens.map((i) => i.rotulo)).toEqual(['CX velho'])
  })
  it('agrupar por filial usa a filial do dono', async () => {
    const r = await cockpit('?agrupar=filial', TF)
    expect(r.grupos.find((g) => g.chave === FX)).toMatchObject({ rotulo: 'Filial X', esquecidos: 1 })
    expect(r.grupos.map((g) => g.chave)).not.toContain(FY)
  })
  it('dois tenants: o vizinho só enxerga o dele', async () => {
    const r = await cockpit('', T2)
    expect(r.cards.esquecidos).toBe(1)
    expect(r.cards.aguardandoHumano.total).toBe(1)
    expect(r.cards.slaEstouradoHoje).toBe(0)
    const l = await itens('card=esquecidos', T2)
    expect(l.itens.map((i) => i.rotulo)).toEqual(['Só do vizinho'])
  })
})
