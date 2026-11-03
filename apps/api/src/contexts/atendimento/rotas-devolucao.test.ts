import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'

/**
 * G1 — devolver ao agente, reatribuir e filtro `conduzidoPor`.
 * Dev (header x-tenant-id): o chamador é `dev-<tenant>`. Fixtures exclusivas
 * deste arquivo (a suíte roda em paralelo).
 */
const T = 'c1d00000-0000-4000-8000-000000000001'
const T2 = 'c1d00000-0000-4000-8000-000000000002'
const PV = 'c1d00000-1111-4000-8000-000000000001'
const PV2 = 'c1d00000-1111-4000-8000-000000000002'
const PLANO = 'c1d00000-3333-4000-8000-000000000001'
const MODELO = 'c1d00000-4444-4000-8000-000000000001'
const CANAL_AUTO = 'c1d00000-5555-4000-8000-000000000001'
const CANAL_OFF = 'c1d00000-5555-4000-8000-000000000002'
const CANAL_T2 = 'c1d00000-5555-4000-8000-000000000003'
const EU = 'c1d00000-6666-4000-8000-000000000001'
const OUTRO = 'c1d00000-6666-4000-8000-000000000002'
const ADMIN = 'c1d00000-6666-4000-8000-000000000003'
const INATIVO = 'c1d00000-6666-4000-8000-000000000004'
const DE_T2 = 'c1d00000-6666-4000-8000-000000000005'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance

const post = (url: string, body: unknown, tenant = T) =>
  app.inject({ method: 'POST', url, headers: { 'x-tenant-id': tenant }, payload: body as object })
const get = (url: string, tenant = T) => app.inject({ method: 'GET', url, headers: { 'x-tenant-id': tenant } })
const papel = (u: string, p: string | null) => p === null
  ? dono`DELETE FROM usuario_filial WHERE tenant_id = ${T} AND usuario_id = ${u}`
  : dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES (${T}, ${u}, NULL, ${p})
         ON CONFLICT (tenant_id, usuario_id) WHERE filial_id IS NULL DO UPDATE SET papel = EXCLUDED.papel`

/**
 * Conversa nova; `atendente` = quem conduz (null = sem atendimento).
 *
 * ⚠️ O cliente nasce na CARTEIRA do EU (escopo D3): com um admin no tenant, o EU
 *    sem papel só enxerga a própria carteira — sem isto as rotas responderiam 404
 *    antes de chegar à regra que cada teste exercita.
 */
async function conversa(canal: string, atendente: string | null, opts: { conduzida?: string; estado?: string } = {}) {
  const contato = randomUUID(); const id = randomUUID(); const at = randomUUID()
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES (${T}, ${contato}, 'Cliente G1', 'teste', true)`
  await dono`INSERT INTO carteira_atribuicao (tenant_id, id, contato_id, usuario_id) VALUES (${T}, ${randomUUID()}, ${contato}, ${EU})`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao, conduzida_por)
             VALUES (${T}, ${id}, ${canal}, ${contato}, 0, ${opts.conduzida ?? 'humano'})`
  if (atendente) {
    await dono`INSERT INTO atendimento (tenant_id, id, conversa_id, canal_id, protocolo, atendente_id, estado, assumido_em)
               VALUES (${T}, ${at}, ${id}, ${canal}, proximo_numero(${T}, 'protocolo'), ${atendente}, ${opts.estado ?? 'em_atendimento'}, now())`
  }
  return { id, at }
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-g1', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-g1', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [tenant, perfil, nome] of [[T, PV, 'Loja G1'], [T2, PV2, 'Loja G1 Vizinha']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${tenant}, ${nome}, ${PLANO}, ${perfil}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${tenant}, ${perfil}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  for (const [canal, nome] of [[CANAL_AUTO, 'Auto'], [CANAL_OFF, 'Off']] as const) {
    await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado)
               VALUES (${T}, ${canal}, 'whatsapp_nao_oficial', 'plugzapi', ${nome}, 'conectado')`
  }
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado)
             VALUES (${T2}, ${CANAL_T2}, 'whatsapp_nao_oficial', 'plugzapi', 'Vizinha', 'conectado')`
  await dono`INSERT INTO agente_config (tenant_id, canal_id, modo, politicas) VALUES (${T}, ${CANAL_AUTO}, 'autonomo', 'Atenda com educação.')`
  await dono`INSERT INTO agente_config (tenant_id, canal_id, modo) VALUES (${T}, ${CANAL_OFF}, 'sombra')`
  for (const [id, sub, nome, ativo] of [
    [EU, `dev-${T}`, 'Eu', true], [OUTRO, 'sub-outro-g1', 'Outro', true],
    [ADMIN, 'sub-admin-g1', 'Ada', true], [INATIVO, 'sub-inativo-g1', 'Inativo', false],
  ] as const) {
    await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email, ativo)
               VALUES (${T}, ${id}, ${sub}, ${nome}, ${`${nome}@g1.test`}, ${ativo})`
  }
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${T2}, ${DE_T2}, 'sub-t2-g1', 'Vizinho', 'v@g1.test')`
  await papel(ADMIN, 'admin') // encerra o modo fundador: EU passa a ter só o que lhe derem
  app = await criarApp(); await app.ready()
})

afterAll(async () => {
  for (const t of ['notificacao', 'outbox', 'auditoria', 'agente_sessao', 'mensagem', 'atendimento', 'conversa_leitura', 'conversa', 'carteira_atribuicao', 'contato',
    'usuario_filial', 'agente_config', 'usuario', 'canal_conectado']) {
    await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id IN ('${T}', '${T2}')`)
  }
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id IN (${T}, ${T2})`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id IN (${T}, ${T2})`
  await dono`DELETE FROM tenant WHERE id IN (${T}, ${T2})`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('POST /v1/conversas/:id/devolver-agente', () => {
  it('caminho feliz (agente autônomo): encerra o atendimento, devolve a condução e deixa o motivo para o agente', async () => {
    const c = await conversa(CANAL_AUTO, EU)
    const r = await post(`/v1/conversas/${c.id}/devolver-agente`, { motivo: 'cliente_quer_continuar_com_agente', observacao: 'pediu o robô' })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ ok: true, jaDevolvida: false, destino: 'agente', modoEfetivo: 'autonomo' })
    const [a] = await dono<{ estado: string; encerrado_em: Date | null }[]>`SELECT estado, encerrado_em FROM atendimento WHERE tenant_id = ${T} AND id = ${c.at}`
    expect(a!.estado).toBe('encerrado'); expect(a!.encerrado_em).not.toBeNull()
    const [cv] = await dono<{ conduzida_por: string }[]>`SELECT conduzida_por FROM conversa WHERE tenant_id = ${T} AND id = ${c.id}`
    expect(cv!.conduzida_por).toBe('ia')
    const [s] = await dono<{ estado_agente: { devolucao: { motivo: string; observacao: string } } }[]>`
      SELECT estado_agente FROM agente_sessao WHERE tenant_id = ${T} AND conversa_id = ${c.id} AND estado = 'ativa'`
    expect(s!.estado_agente.devolucao).toMatchObject({ motivo: 'cliente_quer_continuar_com_agente', observacao: 'pediu o robô' })
    const [aud] = await dono`SELECT 1 FROM auditoria WHERE tenant_id = ${T} AND entidade_id = ${c.id} AND acao = 'conversa.devolvida_ao_agente'`
    expect(aud).toBeDefined()
  })

  it('o evento de outbox não carrega conteúdo: só conversaId e versão', async () => {
    const c = await conversa(CANAL_AUTO, EU)
    await post(`/v1/conversas/${c.id}/devolver-agente`, { motivo: 'outro', observacao: 'texto secreto do atendente' })
    const ev = await dono<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM outbox WHERE tenant_id = ${T} AND agregado_id = ${c.id} AND tipo = 'conversa.devolvida'`
    expect(ev).toHaveLength(1)
    expect(Object.keys(ev[0]!.payload).sort()).toEqual(['conversaId', 'versao'])
  })

  it('idempotente: devolver de novo responde 200 sem repetir efeito', async () => {
    const c = await conversa(CANAL_AUTO, EU)
    await post(`/v1/conversas/${c.id}/devolver-agente`, { motivo: 'fora_do_horario' })
    const r2 = await post(`/v1/conversas/${c.id}/devolver-agente`, { motivo: 'fora_do_horario' })
    expect(r2.statusCode).toBe(200)
    expect(r2.json()).toMatchObject({ jaDevolvida: true, destino: 'agente' })
    const [n] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM outbox WHERE tenant_id = ${T} AND agregado_id = ${c.id} AND tipo = 'conversa.devolvida'`
    expect(n!.n).toBe(1)
  })

  it('409 tipificado quando a conversa não está com humano', async () => {
    const c = await conversa(CANAL_AUTO, null)
    const r = await post(`/v1/conversas/${c.id}/devolver-agente`, { motivo: 'outro' })
    expect(r.statusCode).toBe(409)
    expect(r.json()).toMatchObject({ erro: 'conversa.sem_atendimento_humano' })
  })

  it('valida o motivo e o tamanho da observação (422)', async () => {
    const c = await conversa(CANAL_AUTO, EU)
    expect((await post(`/v1/conversas/${c.id}/devolver-agente`, { motivo: 'qualquer' })).statusCode).toBe(422)
    expect((await post(`/v1/conversas/${c.id}/devolver-agente`, { motivo: 'outro', observacao: 'x'.repeat(301) })).statusCode).toBe(422)
  })

  it('papel: atendimento de OUTRA pessoa só a gestão devolve', async () => {
    const c = await conversa(CANAL_AUTO, OUTRO)
    await papel(EU, null)
    const negado = await post(`/v1/conversas/${c.id}/devolver-agente`, { motivo: 'outro' })
    expect(negado.statusCode).toBe(403)
    await papel(EU, 'supervisor')
    const ok = await post(`/v1/conversas/${c.id}/devolver-agente`, { motivo: 'outro' })
    expect(ok.statusCode).toBe(200)
    await papel(EU, null)
  })

  it('⚠️ agente em sombra no número: a conversa vai para a FILA, não some', async () => {
    const c = await conversa(CANAL_OFF, EU)
    const r = await post(`/v1/conversas/${c.id}/devolver-agente`, { motivo: 'resolvido_pelo_humano' })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ destino: 'fila', modoEfetivo: 'sombra' })
    expect((r.json() as { aviso: string }).aviso).toMatch(/fila/)
    const [a] = await dono<{ estado: string; atendente_id: string | null; sla_vence_em: Date | null }[]>`
      SELECT estado, atendente_id, sla_vence_em FROM atendimento WHERE tenant_id = ${T} AND id = ${c.at}`
    expect(a).toMatchObject({ estado: 'na_fila', atendente_id: null })
    expect(a!.sla_vence_em).not.toBeNull()
    const [cv] = await dono<{ conduzida_por: string }[]>`SELECT conduzida_por FROM conversa WHERE tenant_id = ${T} AND id = ${c.id}`
    expect(cv!.conduzida_por).toBe('humano')
    // Idempotente também no caminho da fila.
    const r2 = await post(`/v1/conversas/${c.id}/devolver-agente`, { motivo: 'resolvido_pelo_humano' })
    expect(r2.json()).toMatchObject({ jaDevolvida: true, destino: 'fila' })
  })

  it('dois tenants: o vizinho não enxerga a conversa (404)', async () => {
    const c = await conversa(CANAL_AUTO, EU)
    const r = await post(`/v1/conversas/${c.id}/devolver-agente`, { motivo: 'outro' }, T2)
    expect(r.statusCode).toBe(404)
    const [a] = await dono<{ estado: string }[]>`SELECT estado FROM atendimento WHERE tenant_id = ${T} AND id = ${c.at}`
    expect(a!.estado).toBe('em_atendimento')
  })
})

describe('POST /v1/conversas/:id/reatribuir', () => {
  it('papel: sem gestão, 403', async () => {
    const c = await conversa(CANAL_AUTO, EU)
    await papel(EU, null)
    const r = await post(`/v1/conversas/${c.id}/reatribuir`, { usuarioId: OUTRO, motivo: 'férias' })
    expect(r.statusCode).toBe(403)
  })

  it('gestor reatribui: troca o responsável, notifica o destino e audita', async () => {
    const c = await conversa(CANAL_AUTO, EU)
    await papel(EU, 'gestor')
    const r = await post(`/v1/conversas/${c.id}/reatribuir`, { usuarioId: OUTRO, motivo: 'especialista no assunto' })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ ok: true, jaEra: false, para: 'Outro' })
    const [a] = await dono<{ atendente_id: string }[]>`SELECT atendente_id FROM atendimento WHERE tenant_id = ${T} AND id = ${c.at}`
    expect(a!.atendente_id).toBe(OUTRO)
    const [n] = await dono`SELECT 1 FROM notificacao WHERE tenant_id = ${T} AND usuario_id = ${OUTRO} AND conversa_id = ${c.id}`
    expect(n).toBeDefined()
    const [aud] = await dono`SELECT 1 FROM auditoria WHERE tenant_id = ${T} AND entidade_id = ${c.id} AND acao = 'atendimento.reatribuido'`
    expect(aud).toBeDefined()
    const again = await post(`/v1/conversas/${c.id}/reatribuir`, { usuarioId: OUTRO, motivo: 'de novo' })
    expect(again.json()).toMatchObject({ jaEra: true })
    await papel(EU, null)
  })

  it('usuário de outro tenant: 404; inativo: 422; sem motivo: 422', async () => {
    const c = await conversa(CANAL_AUTO, EU)
    await papel(EU, 'gestor')
    expect((await post(`/v1/conversas/${c.id}/reatribuir`, { usuarioId: DE_T2, motivo: 'x' })).statusCode).toBe(404)
    expect((await post(`/v1/conversas/${c.id}/reatribuir`, { usuarioId: INATIVO, motivo: 'x' })).statusCode).toBe(422)
    expect((await post(`/v1/conversas/${c.id}/reatribuir`, { usuarioId: OUTRO, motivo: '  ' })).statusCode).toBe(422)
    await papel(EU, null)
  })
})

describe('GET /v1/conversas?conduzidoPor=', () => {
  it('separa agente, humano e aguardando, e combina com o filtro atual', async () => {
    const ag = await conversa(CANAL_AUTO, null, { conduzida: 'ia' })
    const hu = await conversa(CANAL_AUTO, OUTRO)
    const fi = await conversa(CANAL_AUTO, null)
    await dono`UPDATE conversa SET ultima_direcao = 'entrante', ultima_mensagem_em = now() WHERE tenant_id = ${T} AND id = ${fi.id}`
    const ids = async (qs: string) => ((await get(`/v1/conversas?limite=100&${qs}`)).json() as { itens: { id: string }[] }).itens.map((i) => i.id)

    const agente = await ids('conduzidoPor=agente')
    expect(agente).toContain(ag.id); expect(agente).not.toContain(hu.id)
    const humano = await ids('conduzidoPor=humano')
    expect(humano).toContain(hu.id); expect(humano).not.toContain(ag.id)
    const aguardando = await ids('conduzidoPor=aguardando')
    expect(aguardando).toContain(fi.id); expect(aguardando).not.toContain(hu.id)
    // Combinado com `fila`: o humano em atendimento nunca está na fila.
    expect(await ids('filtro=fila&conduzidoPor=humano')).not.toContain(hu.id)
    expect((await get('/v1/conversas?conduzidoPor=zzz')).statusCode).toBe(422)
  })
})
