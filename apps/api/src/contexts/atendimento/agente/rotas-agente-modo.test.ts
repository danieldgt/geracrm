import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../../app.js'
import { encerrarBanco } from '../../../db/index.js'
import { diferencaDeConfig } from './auditoria-config.js'

/**
 * MODO DO AGENTE NA API (raia P14, ADR-028): confirmação digitada, papel admin,
 * auditoria {antes, depois}, recorte e o teto do tenant (kill switch geral).
 *
 * ⚠️ O que se protege aqui é o clique que solta o robô para falar sozinho com
 *    os clientes de alguém — ou que o cala para todos. Os dois exigem digitar o
 *    nome do modo, exigem admin e deixam rastro de quem, quando e o que mudou.
 */
const T = 'a14d0000-0000-4000-8000-000000000001'
const OUTRO = 'a14d0000-0000-4000-8000-000000000002'
const PV = 'a14d0000-1111-4000-8000-000000000001'
const PV2 = 'a14d0000-1111-4000-8000-000000000002'
const PLANO = 'a14d0000-3333-4000-8000-000000000001'
const MODELO = 'a14d0000-4444-4000-8000-000000000001'
const CANAL = 'a14d0000-7777-4000-8000-000000000001'
const ADMIN = 'a14d0000-8888-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const chamar = (t: string, m: 'GET' | 'PUT', url: string, corpo?: Record<string, unknown>) =>
  app.inject({ method: m, url, headers: { 'x-tenant-id': t }, ...(corpo ? { payload: corpo } : {}) })
const URL_CFG = `/v1/canais/${CANAL}/agente`
const POLITICAS = 'Entrega em 3 dias úteis. Pagamento por PIX ou cartão.'
const DIAS = ['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom'] as const

const auditorias = async (entidade: string) => dono<{ acao: string; entidade: string; ator_id: string | null; dados: { antes: Record<string, unknown>; depois: Record<string, unknown>; campos: string[] } }[]>`
  SELECT acao, entidade, ator_id, dados FROM auditoria WHERE tenant_id = ${T} AND entidade = ${entidade} ORDER BY criado_em`

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  process.env.ANTHROPIC_API_KEY ||= 'chave-de-teste'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-rotas-modo', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-rotas-modo', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'A'], [OUTRO, PV2, 'B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await dono`UPDATE tenant SET fuso = 'America/Sao_Paulo' WHERE id IN (${T}, ${OUTRO})`
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado)
             VALUES (${T}, ${CANAL}, 'whatsapp_nao_oficial', 'Loja Centro', 'conectado') ON CONFLICT DO NOTHING`
  app = await criarApp(); await app.ready()
})

beforeEach(async () => {
  for (const t of ['agente_config', 'agente_tenant', 'auditoria', 'usuario_filial']) {
    await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id IN ('${T}', '${OUTRO}')`)
  }
  await dono`DELETE FROM usuario WHERE tenant_id IN (${T}, ${OUTRO}) AND id = ${ADMIN}`
})

afterAll(async () => {
  for (const t of ['agente_config', 'agente_tenant', 'auditoria', 'usuario_filial', 'conhecimento_documento_versao', 'conhecimento_trecho', 'conhecimento_documento', 'usuario', 'canal_conectado']) {
    await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id IN ('${T}', '${OUTRO}')`).catch(() => undefined)
  }
  for (const t of [T, OUTRO]) {
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

/** Encerra o modo fundador: outra pessoa vira admin; o usuário do header fica sem papel. */
async function tirarAdminDoUsuarioDoHeader(): Promise<void> {
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${T}, ${ADMIN}, 'sub-admin-p14', 'Ada', 'ada@p14.test') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES (${T}, ${ADMIN}, NULL, 'admin')`
}

describe('Confirmação digitada (ADR-028 §5)', () => {
  it('PUT para autônomo SEM confirmação → 422 agente.confirmacao_necessaria, nada gravado', async () => {
    const r = await chamar(T, 'PUT', URL_CFG, { modo: 'autonomo', politicas: POLITICAS })
    expect(r.statusCode).toBe(422)
    expect(r.json()).toMatchObject({ erro: 'agente.confirmacao_necessaria', confirmar: 'autonomo', campos: ['confirmacao'] })
    expect(await dono`SELECT 1 FROM agente_config WHERE tenant_id = ${T}`).toHaveLength(0)
  })

  it('confirmação errada também é recusada', async () => {
    const r = await chamar(T, 'PUT', URL_CFG, { modo: 'autonomo', politicas: POLITICAS, confirmacao: 'sim' })
    expect(r.json()).toMatchObject({ erro: 'agente.confirmacao_necessaria' })
  })

  it('aceita o nome do modo com acento e caixa', async () => {
    const r = await chamar(T, 'PUT', URL_CFG, { modo: 'autonomo', politicas: POLITICAS, confirmacao: ' Autônomo ' })
    expect(r.statusCode).toBe(200)
    // Salvar de novo no MESMO modo não pede confirmação.
    expect((await chamar(T, 'PUT', URL_CFG, { modo: 'autonomo', politicas: POLITICAS })).statusCode).toBe(200)
  })

  it('desligar a partir de autônomo também pede; sombra e assistido não', async () => {
    await chamar(T, 'PUT', URL_CFG, { modo: 'autonomo', politicas: POLITICAS, confirmacao: 'autonomo' })
    expect((await chamar(T, 'PUT', URL_CFG, { modo: 'desligado', politicas: POLITICAS })).json()).toMatchObject({ erro: 'agente.confirmacao_necessaria', confirmar: 'desligado' })
    expect((await chamar(T, 'PUT', URL_CFG, { modo: 'sombra', politicas: POLITICAS })).statusCode).toBe(200)
    expect((await chamar(T, 'PUT', URL_CFG, { modo: 'assistido', politicas: POLITICAS })).statusCode).toBe(200)
    expect((await chamar(T, 'PUT', URL_CFG, { modo: 'desligado', politicas: POLITICAS, confirmacao: 'DESLIGADO' })).statusCode).toBe(200)
  })
})

describe('Papel admin', () => {
  it('usuário sem papel (fora do modo fundador) → 403 no PUT; GET segue e diz que não pode configurar', async () => {
    await tirarAdminDoUsuarioDoHeader()
    const r = await chamar(T, 'PUT', URL_CFG, { modo: 'sombra', politicas: POLITICAS })
    expect(r.statusCode).toBe(403)
    expect(r.json()).toMatchObject({ erro: 'acesso.papel_insuficiente' })
    expect((await chamar(T, 'PUT', '/v1/agente/tenant', { modoMaximo: 'desligado', confirmacao: 'desligado' })).statusCode).toBe(403)
    const g = await chamar(T, 'GET', URL_CFG)
    expect(g.statusCode).toBe(200)
    expect(g.json()).toMatchObject({ podeConfigurar: false })
  })

  it('no modo fundador (sem admin no tenant) quem está logado configura', async () => {
    expect((await chamar(T, 'PUT', URL_CFG, { modo: 'sombra', politicas: POLITICAS })).statusCode).toBe(200)
    expect((await chamar(T, 'GET', URL_CFG)).json()).toMatchObject({ podeConfigurar: true })
  })
})

describe('Auditoria agente.config_alterada', () => {
  it('cada PUT grava {antes, depois} só do que mudou, com o autor', async () => {
    await chamar(T, 'PUT', URL_CFG, { modo: 'sombra', politicas: POLITICAS })
    await chamar(T, 'PUT', URL_CFG, { modo: 'autonomo', politicas: POLITICAS, confirmacao: 'autonomo' })
    const a = await auditorias('agente_config')
    expect(a).toHaveLength(2)
    expect(a.every((x) => x.acao === 'agente.config_alterada' && x.ator_id !== null)).toBe(true)
    expect(a[1]!.dados.antes).toEqual({ modo: 'sombra' })
    expect(a[1]!.dados.depois).toEqual({ modo: 'autonomo' })
    expect(a[1]!.dados.campos).toEqual(['modo'])
  })

  it('PUT recusado (sem confirmação) não deixa auditoria', async () => {
    await chamar(T, 'PUT', URL_CFG, { modo: 'autonomo', politicas: POLITICAS })
    expect(await auditorias('agente_config')).toHaveLength(0)
  })

  it('diferencaDeConfig corta texto longo e ignora ordem de chave em JSON', () => {
    const longo = 'x'.repeat(900)
    const d = diferencaDeConfig({ politicas: 'a', persona: { nome: 'Lia', tom: 'neutro' }, atualizado_em: 1 },
      { politicas: longo, persona: { tom: 'neutro', nome: 'Lia' }, atualizado_em: 2 })
    expect(d.campos).toEqual(['politicas'])
    expect(String(d.depois['politicas'])).toContain('(900 caracteres)')
    expect(String(d.depois['politicas']).length).toBeLessThan(560)
  })
})

describe('Recorte e modo efetivo na tela', () => {
  it('salva o recorte, relê e mostra o efetivo de agora com a origem', async () => {
    const [l] = await dono<{ dia: number }[]>`SELECT to_char(now() AT TIME ZONE 'America/Sao_Paulo', 'ID')::int AS dia`
    const outroDia = DIAS[l!.dia % 7]!
    const recorte = { horario: { [outroDia]: { de: '08:00', ate: '18:00' } }, segmentosRfv: ['cliente-fiel'], foraDoRecorte: 'sombra' }
    expect((await chamar(T, 'PUT', URL_CFG, { modo: 'autonomo', politicas: POLITICAS, confirmacao: 'autonomo', recorte })).statusCode).toBe(200)
    const g = (await chamar(T, 'GET', URL_CFG)).json() as Record<string, unknown>
    expect(g['recorte']).toEqual(recorte)
    expect(g['modoEfetivo']).toMatchObject({ modo: 'sombra', origem: 'recorte', motivo: 'fora_do_recorte_horario', dependeDoContato: true })
    // Ausente no corpo = mantém; null = remove.
    await chamar(T, 'PUT', URL_CFG, { modo: 'autonomo', politicas: POLITICAS })
    expect(((await chamar(T, 'GET', URL_CFG)).json() as Record<string, unknown>)['recorte']).toEqual(recorte)
    await chamar(T, 'PUT', URL_CFG, { modo: 'autonomo', politicas: POLITICAS, recorte: null })
    expect((await chamar(T, 'GET', URL_CFG)).json()).toMatchObject({ recorte: null, modoEfetivo: { modo: 'autonomo', origem: 'numero' } })
  })

  it('recorte malformado → 422 com o campo', async () => {
    const r = await chamar(T, 'PUT', URL_CFG, { modo: 'sombra', politicas: POLITICAS, recorte: { foraDoRecorte: 'autonomo' } })
    expect(r.statusCode).toBe(422)
    expect(r.json()).toMatchObject({ erro: 'agente.campo_invalido' })
  })

  it('identificaComoRobo não se desliga pela API (é regra)', async () => {
    await chamar(T, 'PUT', URL_CFG, { modo: 'sombra', politicas: POLITICAS, persona: { nome: 'Lia', identificaComoRobo: false } })
    expect((await chamar(T, 'GET', URL_CFG)).json()).toMatchObject({ persona: { nome: 'Lia', identificaComoRobo: true } })
  })

  it('a tela recebe o estado da reserva de LLM', async () => {
    const g = (await chamar(T, 'GET', URL_CFG)).json() as { reservaLlm: Record<string, unknown> }
    expect(g.reservaLlm).toMatchObject({ situacao: expect.any(String) })
    expect(Array.isArray(g.reservaLlm['faltaParaReserva'])).toBe(true)
  })
})

describe('Teto do tenant — kill switch geral', () => {
  it('sem linha, o teto é autônomo', async () => {
    expect((await chamar(T, 'GET', '/v1/agente/tenant')).json()).toMatchObject({ modoMaximo: 'autonomo', atualizadoEm: null })
  })

  it('desligar exige confirmação; com ela, o efetivo de todo número cai e a auditoria registra', async () => {
    await chamar(T, 'PUT', URL_CFG, { modo: 'autonomo', politicas: POLITICAS, confirmacao: 'autonomo' })
    const sem = await chamar(T, 'PUT', '/v1/agente/tenant', { modoMaximo: 'desligado' })
    expect(sem.json()).toMatchObject({ erro: 'agente.confirmacao_necessaria', confirmar: 'desligado' })
    expect((await chamar(T, 'PUT', '/v1/agente/tenant', { modoMaximo: 'desligado', confirmacao: 'Desligado' })).statusCode).toBe(200)
    expect((await chamar(T, 'GET', '/v1/agente/tenant')).json()).toMatchObject({ modoMaximo: 'desligado', atualizadoPor: expect.any(String) })
    expect((await chamar(T, 'GET', URL_CFG)).json()).toMatchObject({
      modo: 'autonomo', tenant: { modoMaximo: 'desligado' }, modoEfetivo: { modo: 'desligado', origem: 'tenant', motivo: 'teto_do_tenant' },
    })
    const a = await auditorias('agente_tenant')
    expect(a).toHaveLength(1)
    expect(a[0]!.dados).toMatchObject({ antes: { modoMaximo: 'autonomo' }, depois: { modoMaximo: 'desligado' } })
    // Sombra como teto não pede confirmação; voltar a autônomo pede.
    expect((await chamar(T, 'PUT', '/v1/agente/tenant', { modoMaximo: 'sombra' })).statusCode).toBe(200)
    expect((await chamar(T, 'PUT', '/v1/agente/tenant', { modoMaximo: 'autonomo' })).statusCode).toBe(422)
  })

  it('RLS: o teto de um tenant não aparece para o outro', async () => {
    await dono`INSERT INTO agente_tenant (tenant_id, modo_maximo) VALUES (${T}, 'desligado')`
    expect((await chamar(OUTRO, 'GET', '/v1/agente/tenant')).json()).toMatchObject({ modoMaximo: 'autonomo' })
    // O PUT do outro grava a linha DELE, sem tocar a nossa.
    await chamar(OUTRO, 'PUT', '/v1/agente/tenant', { modoMaximo: 'sombra' })
    const linhas = await dono<{ tenant_id: string; modo_maximo: string }[]>`
      SELECT tenant_id, modo_maximo FROM agente_tenant WHERE tenant_id IN (${T}, ${OUTRO}) ORDER BY modo_maximo`
    expect(linhas).toEqual([{ tenant_id: T, modo_maximo: 'desligado' }, { tenant_id: OUTRO, modo_maximo: 'sombra' }])
  })

  it('corpo inválido → 422', async () => {
    expect((await chamar(T, 'PUT', '/v1/agente/tenant', { modoMaximo: 'turbo' })).statusCode).toBe(422)
  })
})
