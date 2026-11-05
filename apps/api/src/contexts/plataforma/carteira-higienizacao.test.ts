import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import type { IndicadorCarteira, RespostaGruposIndicador } from '@geracrm/shared'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'

/**
 * D2 — higienização da carteira. Tenants (o chamador do modo dev é sempre `dev-<tenant>`):
 * T = gestor de tudo; TF = gestor da filial X; TV = vendedor (403); T2 = vizinho.
 */
const T = 'd2d00000-0000-4000-8000-000000000001'
const TF = 'd2d00000-0000-4000-8000-000000000002'
const TV = 'd2d00000-0000-4000-8000-000000000003'
const T2 = 'd2d00000-0000-4000-8000-000000000004'
const TENANTS = [T, TF, TV, T2]
const PLANO = 'd2d00000-3333-4000-8000-000000000001'
const MODELO = 'd2d00000-4444-4000-8000-000000000001'
const id = (n: number, g = 6) => `d2d00000-${g}${g}${g}${g}-4000-8000-${String(n).padStart(12, '0')}`
const EU = id(1); const V1 = id(3); const V2 = id(4)
const EU_F = id(11); const VX = id(13); const VY = id(14)
const EU_V = id(21); const EU_2 = id(31)
const FX = id(1, 7); const FY = id(2, 7)

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const get = (url: string, tenant = T) => app.inject({ method: 'GET', url, headers: { 'x-tenant-id': tenant } })
const indicador = async (q = '', tenant = T) => (await get(`/v1/gestao/carteira/indicador${q}`, tenant)).json() as IndicadorCarteira
const grupos = async (q: string, tenant = T) => (await get(`/v1/gestao/carteira/indicador/grupos?${q}`, tenant)).json() as RespostaGruposIndicador
const dia = 86_400_000

async function contato(t: string, nome: string, o: { qualificado?: boolean; dono?: string; filial?: string } = {}) {
  const c = randomUUID()
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo, qualificado, qualificado_em, filial_id)
             VALUES (${t}, ${c}, ${nome}, 'teste', true, ${o.qualificado ?? null}, ${o.qualificado ? new Date() : null}, ${o.filial ?? null})`
  if (o.dono) await dono`INSERT INTO carteira_atribuicao (tenant_id, id, contato_id, usuario_id) VALUES (${t}, ${randomUUID()}, ${c}, ${o.dono})`
  return c
}
const tarefa = (t: string, c: string, venceEm: Date) =>
  dono`INSERT INTO tarefa (tenant_id, id, contato_id, titulo, vence_em) VALUES (${t}, ${randomUUID()}, ${c}, 'Ligar', ${venceEm})`
const evento = (t: string, c: string, resp: string, inicio: Date) =>
  dono`INSERT INTO evento_agenda (tenant_id, id, titulo, contato_id, responsavel_id, inicio, fim, status)
       VALUES (${t}, ${randomUUID()}, 'Reunião D2', ${c}, ${resp}, ${inicio}, ${new Date(inicio.getTime() + 1_800_000)}, 'agendado')`
const papel = (t: string, u: string, p: string, filial: string | null = null) =>
  dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES (${t}, ${u}, ${filial}, ${p})`

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-d2', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-d2', 'Varejo') ON CONFLICT DO NOTHING`
  for (const t of TENANTS) {
    const pv = id(Number(t.slice(-1)), 8)
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${`Loja D2 ${t.slice(-1)}`}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  for (const [t, f, nome] of [[TF, FX, 'Filial X'], [TF, FY, 'Filial Y']] as const) {
    await dono`INSERT INTO filial (tenant_id, id, nome) VALUES (${t}, ${f}, ${nome})`
  }
  for (const [t, u, sub, nome] of [
    [T, EU, `dev-${T}`, 'Eu'], [T, V1, 'sub-v1-d2', 'Vera'], [T, V2, 'sub-v2-d2', 'Caio'],
    [TF, EU_F, `dev-${TF}`, 'Eu F'], [TF, VX, 'sub-vx-d2', 'Vendedor X'], [TF, VY, 'sub-vy-d2', 'Vendedor Y'],
    [TV, EU_V, `dev-${TV}`, 'Eu V'], [T2, EU_2, `dev-${T2}`, 'Eu 2'],
  ] as const) {
    await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${t}, ${u}, ${sub}, ${nome}, ${`${sub}@d2.test`})`
  }
  await papel(T, EU, 'admin'); await papel(T, V1, 'vendedor'); await papel(T, V2, 'vendedor')
  await papel(TF, EU_F, 'gestor', FX); await papel(TF, VX, 'vendedor', FX); await papel(TF, VY, 'vendedor', FY)
  await papel(TV, EU_V, 'vendedor')
  // O modo fundador (sem admin ativo) trataria o chamador como admin: o tenant de filial e o de vendedor precisam de um.
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${TF}, ${id(12)}, 'sub-adm-f-d2', 'Ada F', 'adm-f@d2.test')`
  await papel(TF, id(12), 'admin')
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${TV}, ${id(22)}, 'sub-adm-v-d2', 'Ada V', 'adm-v@d2.test')`
  await papel(TV, id(22), 'admin')
  for (const t of [T, TF]) {
    await dono`INSERT INTO funil_etapa (tenant_id, id, ordem, chave, nome, tipo) VALUES
      (${t}, ${randomUUID()}, 1, 'lead', 'Lead', 'aberto') ON CONFLICT (tenant_id, chave) DO NOTHING`
  }
  const [etapa] = await dono<{ id: string }[]>`SELECT id FROM funil_etapa WHERE tenant_id = ${T} AND chave = 'lead'`
  const agora = Date.now()

  // ── T: 5 ativos (A, B, C, D, F) e 1 inativo (E) ──
  await contato(T, 'A qualificado sem passo', { qualificado: true, dono: V1 })
  const b = await contato(T, 'B qualificado com tarefa', { qualificado: true, dono: V1 })
  await tarefa(T, b, new Date(agora + dia))
  const c = await contato(T, 'C em funil com reunião', { dono: V2 })
  await dono`INSERT INTO oportunidade (tenant_id, id, contato_id, etapa_id, responsavel_id) VALUES (${T}, ${randomUUID()}, ${c}, ${etapa!.id}, ${V2})`
  await evento(T, c, V2, new Date(agora + 2 * dia))
  const d = await contato(T, 'D em funil sem dono')
  await dono`INSERT INTO oportunidade (tenant_id, id, contato_id, etapa_id) VALUES (${T}, ${randomUUID()}, ${d}, ${etapa!.id})`
  await contato(T, 'E novo, fora da carteira ativa')
  const f = await contato(T, 'F qualificado com tarefa atrasada', { qualificado: true, dono: V2 })
  await tarefa(T, f, new Date(agora - dia))

  // ── TF: X tem 2 ativos (1 com passo); Y tem 1 ──
  await contato(TF, 'CX sem passo', { qualificado: true, dono: VX, filial: FX })
  const cx2 = await contato(TF, 'CX2 com tarefa', { qualificado: true, dono: VX })
  await tarefa(TF, cx2, new Date(agora + dia))
  await contato(TF, 'CY sem passo', { qualificado: true, dono: VY })
  // ── T2: vizinho ──
  await contato(T2, 'Só do vizinho', { qualificado: true })
  app = await criarApp(); await app.ready()
})

afterAll(async () => {
  const ids = TENANTS.map((t) => `'${t}'`).join(',')
  for (const t of ['evento_agenda', 'tenant_modulo', 'tarefa', 'oportunidade', 'carteira_atribuicao', 'contato',
    'funil_etapa', 'usuario_filial', 'usuario', 'filial', 'outbox', 'auditoria']) {
    await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id IN (${ids})`)
  }
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id IN ${dono(TENANTS)}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id IN ${dono(TENANTS)}`
  await dono`DELETE FROM tenant WHERE id IN ${dono(TENANTS)}`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('indicador — agenda desligada', () => {
  it('ativos = qualificado ou em funil; só tarefa aberta FUTURA conta como próximo passo', async () => {
    expect(await indicador()).toEqual({ ativos: 5, comProximoPasso: 1, semProximoPasso: 4, percentual: 20, meta: 95 })
  })
  it('filtra por vendedor e por "sem dono"', async () => {
    expect(await indicador(`?vendedorId=${V1}`)).toMatchObject({ ativos: 2, comProximoPasso: 1, percentual: 50 })
    expect(await indicador('?vendedorId=sem-dono')).toMatchObject({ ativos: 1, comProximoPasso: 0 })
  })
  it('a lista de contatos com os mesmos filtros bate com o "sem próximo passo" do indicador', async () => {
    const r = await get('/v1/contatos?semProximoPasso=true&carteiraAtiva=true')
    expect((r.json() as { itens: unknown[] }).itens).toHaveLength(4)
  })
  it('grupos por vendedor: pior primeiro, "sem responsável" à parte', async () => {
    const r = await grupos('agrupar=vendedor')
    expect(r.agrupar).toBe('vendedor')
    const por = Object.fromEntries(r.grupos.map((g) => [g.rotulo, [g.ativos, g.comProximoPasso]]))
    expect(por).toEqual({ Vera: [2, 1], Caio: [2, 0], 'Sem responsável': [1, 0] })
    expect(r.grupos[0]!.semProximoPasso).toBeGreaterThanOrEqual(r.grupos[1]!.semProximoPasso)
    expect(r.grupos.find((g) => g.rotulo === 'Sem responsável')!.chave).toBe('sem')
  })
  it('parâmetros inválidos → 422 tipificado', async () => {
    expect((await get('/v1/gestao/carteira/indicador/grupos?agrupar=praca')).statusCode).toBe(422)
    expect((await get('/v1/gestao/carteira/indicador?filialId=nao-uuid')).statusCode).toBe(422)
  })
})

describe('indicador — agenda ligada', () => {
  beforeAll(async () => {
    await dono`INSERT INTO tenant_modulo (tenant_id, modulo, ativo) VALUES (${T}, 'agenda', true)
               ON CONFLICT (tenant_id, modulo) DO UPDATE SET ativo = true`
  })
  it('o evento futuro também é próximo passo', async () => {
    expect(await indicador()).toMatchObject({ ativos: 5, comProximoPasso: 2, semProximoPasso: 3, percentual: 40 })
    expect(await grupos('agrupar=vendedor').then((r) => r.grupos.find((g) => g.rotulo === 'Caio'))).toMatchObject({ ativos: 2, comProximoPasso: 1 })
  })
  it('a lista acompanha: sem passo cai de 4 para 3', async () => {
    const r = await get('/v1/contatos?semProximoPasso=true&carteiraAtiva=true')
    expect((r.json() as { itens: unknown[] }).itens).toHaveLength(3)
  })
})

describe('escopo e isolamento', () => {
  it('gestor da filial X só vê a filial X (a Y some, inclusive no filtro explícito)', async () => {
    expect(await indicador('', TF)).toMatchObject({ ativos: 2, comProximoPasso: 1, percentual: 50 })
    const g = await grupos('agrupar=filial', TF)
    expect(g.grupos.map((x) => x.rotulo)).toEqual(['Filial X'])
    expect(await indicador(`?filialId=${FY}`, TF)).toMatchObject({ ativos: 0, percentual: 100 })
    expect(await indicador(`?filialId=${FX}`, TF)).toMatchObject({ ativos: 2 })
  })
  it('vendedor → 403 nas duas rotas', async () => {
    expect((await get('/v1/gestao/carteira/indicador', TV)).statusCode).toBe(403)
    expect((await get('/v1/gestao/carteira/indicador/grupos?agrupar=filial', TV)).statusCode).toBe(403)
  })
  it('dois tenants: cada um conta só o seu', async () => {
    expect((await indicador('', T2)).ativos).toBe(1)
    expect((await indicador('', T)).ativos).toBe(5)
  })
})
