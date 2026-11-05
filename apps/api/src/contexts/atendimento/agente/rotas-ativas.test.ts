import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { ATIVAS_PADRAO } from '@geracrm/shared'
import { criarApp } from '../../../app.js'
import { encerrarBanco } from '../../../db/index.js'

/**
 * Rotas das MENSAGENS ATIVAS (raia P11): leitura do estado (limites, feriados,
 * expediente, suspensão, template), gravação só por admin e auditada, liberar a
 * suspensão, e a lista de templates aprovados por cursor. Dois tenants.
 */
const A = 'b11c0000-0000-4000-8000-000000000001'
const B = 'b11c0000-0000-4000-8000-000000000002'
const PV_A = 'b11c0000-1111-4000-8000-000000000001'
const PV_B = 'b11c0000-1111-4000-8000-000000000002'
const PLANO = 'b11c0000-3333-4000-8000-000000000001'
const MODELO = 'b11c0000-4444-4000-8000-000000000001'
const CANAL = 'b11c0000-5555-4000-8000-000000000001'
const SEM_AGENTE = 'b11c0000-5555-4000-8000-000000000002'
const ADMIN = 'b11c0000-6666-4000-8000-000000000001'
const ATENDENTE = 'b11c0000-6666-4000-8000-000000000002'
const FILIAL = 'b11c0000-7777-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance

const pedir = (metodo: 'GET' | 'PUT' | 'POST', url: string, tenant = A, payload?: object) =>
  app.inject({ method: metodo, url, headers: { 'x-tenant-id': tenant }, ...(payload ? { payload } : {}) })
const URL_ATIVAS = `/v1/canais/${CANAL}/agente/ativas`
const corpoValido = { limiteDia: 1, limiteSemana: 3, templateRetorno: null, feriados: ['12-25', '2026-11-20'] }
const novoTemplate = async (nome: string, status: string, corpo = 'Oi, {{1}}!') => {
  const id = randomUUID()
  await dono`INSERT INTO template (tenant_id, id, nome, categoria, idioma) VALUES (${A}, ${id}, ${nome}, 'UTILITY', 'pt_BR')`
  await dono`INSERT INTO template_versao (tenant_id, template_id, versao, corpo, status_meta, motivo_rejeicao)
             VALUES (${A}, ${id}, 1, ${JSON.stringify({ body: { texto: corpo } })}::text::jsonb, ${status}, ${status === 'REJECTED' ? 'x' : null})`
  return id
}

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-p11-rotas', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-p11-rotas', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv] of [[A, PV_A], [B, PV_B]] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, 'P11 Rotas', ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado)
             VALUES (${A}, ${CANAL}, 'whatsapp_oficial', 'meta_oficial', 'Oficial', 'conectado'),
                    (${A}, ${SEM_AGENTE}, 'whatsapp_nao_oficial', 'plugzapi', 'Sem agente', 'conectado') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO agente_config (tenant_id, canal_id, ativo, modo, politicas, persona, alcada)
             VALUES (${A}, ${CANAL}, true, 'sombra', 'x', '{"nome":"Lia","loja":"Loja"}'::jsonb, '{}'::jsonb) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO filial (tenant_id, id, nome) VALUES (${A}, ${FILIAL}, 'Matriz') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${A}, ${ADMIN}, ${'dev-' + A}, 'Ada', 'ada@p11.test') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${A}, ${ATENDENTE}, 'sub-p11-atendente', 'Ted', 'ted@p11.test') ON CONFLICT DO NOTHING`
  app = await criarApp(); await app.ready()
})

beforeEach(async () => {
  await dono`DELETE FROM usuario_filial WHERE tenant_id = ${A}`
  await dono`DELETE FROM auditoria WHERE tenant_id = ${A}`
  await dono`DELETE FROM alerta WHERE tenant_id = ${A}`
  await dono`DELETE FROM template_versao WHERE tenant_id = ${A}`
  await dono`DELETE FROM template WHERE tenant_id = ${A}`
  await dono`DELETE FROM canal_configuracao WHERE tenant_id = ${A}`
  await dono`UPDATE agente_config SET ativas = '{}'::jsonb WHERE tenant_id = ${A}`
  await dono`UPDATE canal_conectado SET ativas_suspensas_em = NULL, ativas_suspensas_motivo = NULL WHERE tenant_id = ${A}`
})

afterAll(async () => {
  for (const t of ['usuario_filial', 'auditoria', 'alerta', 'template_versao', 'template', 'agente_config', 'canal_configuracao', 'canal_conectado', 'usuario', 'filial']) {
    await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id IN ('${A}', '${B}')`)
  }
  for (const t of [A, B]) {
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('GET /v1/canais/:id/agente/ativas', () => {
  it('sem nada gravado: padrões, oficial exige template, sem horário configurado, expediente aberto', async () => {
    const r = await pedir('GET', URL_ATIVAS)
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({
      config: ATIVAS_PADRAO, padroes: ATIVAS_PADRAO, feriados: [], fuso: 'America/Sao_Paulo', tipoCanal: 'whatsapp_oficial',
      exigeTemplateForaDaJanela: true, horarioConfigurado: false, expediente: { aberto: true }, suspensao: null, template: null,
    })
  })

  it('mostra a suspensão com o motivo', async () => {
    await dono`UPDATE canal_conectado SET ativas_suspensas_em = now(), ativas_suspensas_motivo = 'qualidade:FLAGGED' WHERE id = ${CANAL}`
    expect((await pedir('GET', URL_ATIVAS)).json().suspensao).toMatchObject({ motivo: 'qualidade:FLAGGED' })
  })

  it('⚠️ outro tenant não enxerga o canal (404, RLS)', async () => {
    expect((await pedir('GET', URL_ATIVAS, B)).statusCode).toBe(404)
  })
})

describe('PUT /v1/canais/:id/agente/ativas', () => {
  it('admin grava limites e feriados (normalizados) e a auditoria guarda antes e depois', async () => {
    const r = await pedir('PUT', URL_ATIVAS, A, { ...corpoValido, feriados: ['2026-11-20', '12-25', '12-25'] })
    expect(r.statusCode).toBe(200)
    const g = (await pedir('GET', URL_ATIVAS)).json()
    expect(g.config).toEqual({ ...ATIVAS_PADRAO, limiteDia: 1, limiteSemana: 3, templateRetorno: null })
    expect(g.feriados).toEqual(['12-25', '2026-11-20'])
    const [a] = await dono<{ acao: string; dados: { antes: { limiteDia: number }; depois: { limiteDia: number } } }[]>`
      SELECT acao, dados FROM auditoria WHERE tenant_id = ${A}`
    expect(a).toMatchObject({ acao: 'agente.ativas_alteradas', dados: { antes: { limiteDia: 2 }, depois: { limiteDia: 1 } } })
  })

  it('⚠️ só admin grava: atendente recebe 403 com o papel exigido', async () => {
    await dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES (${A}, ${ATENDENTE}, ${FILIAL}, 'admin')`
    await dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES (${A}, ${ADMIN}, ${FILIAL}, 'atendente')`
    const r = await pedir('PUT', URL_ATIVAS, A, corpoValido)
    expect(r.statusCode).toBe(403)
    expect(r.json()).toMatchObject({ erro: 'acesso.papel_insuficiente', exige: ['admin'] })
  })

  it('validação na borda: semana menor que dia e feriado inválido → 422 com o campo', async () => {
    const r1 = await pedir('PUT', URL_ATIVAS, A, { ...corpoValido, limiteDia: 5, limiteSemana: 2 })
    expect(r1.statusCode).toBe(422)
    expect(r1.json()).toMatchObject({ erro: 'ativas.invalido', campos: ['limiteSemana'] })
    expect((await pedir('PUT', URL_ATIVAS, A, { ...corpoValido, feriados: ['31-12'] })).json()).toMatchObject({ campos: ['feriados'] })
  })

  it('template de retorno: só aprovado e com no máximo {{1}}', async () => {
    const pendente = await novoTemplate('retorno_pendente', 'PENDING')
    const duas = await novoTemplate('retorno_duas', 'APPROVED', 'Oi {{1}}, pedido {{2}}')
    const soDois = await novoTemplate('retorno_so_dois', 'APPROVED', 'Seu pedido {{2}} está salvo')
    expect((await pedir('PUT', URL_ATIVAS, A, { ...corpoValido, templateRetorno: soDois })).json()).toMatchObject({ erro: 'ativas.template_incompativel' })
    const bom = await novoTemplate('retorno_bom', 'APPROVED')
    expect((await pedir('PUT', URL_ATIVAS, A, { ...corpoValido, templateRetorno: pendente })).json()).toMatchObject({ erro: 'ativas.template_indisponivel' })
    expect((await pedir('PUT', URL_ATIVAS, A, { ...corpoValido, templateRetorno: duas })).json()).toMatchObject({ erro: 'ativas.template_incompativel' })
    expect((await pedir('PUT', URL_ATIVAS, A, { ...corpoValido, templateRetorno: bom })).statusCode).toBe(200)
    const g = (await pedir('GET', URL_ATIVAS)).json()
    expect(g.template).toMatchObject({ id: bom, nome: 'retorno_bom', status: 'APPROVED', variaveis: 1, compativel: true })
  })

  it('descarte após a cadência e reativação: grava, devolve no GET e a auditoria guarda antes e depois', async () => {
    const tpl = await novoTemplate('reativacao_bom', 'APPROVED')
    const reativacao = { ativa: true, dias: [30, 90], templateId: tpl, texto: null }
    const r = await pedir('PUT', URL_ATIVAS, A, { ...corpoValido, descarteAposHoras: 48, reativacao })
    expect(r.statusCode).toBe(200)
    const g = (await pedir('GET', URL_ATIVAS)).json()
    expect(g.config).toMatchObject({ descarteAposHoras: 48, reativacao })
    // ⚠️ Descarte DESLIGADO por padrão; reativação desligada, teto de 30 por dia.
    expect(g.padroes).toMatchObject({ descarteAposHoras: 0, reativacao: { ativa: false, dias: [30, 90], limiteDia: 30 } })
    expect(g.config.reativacao.limiteDia).toBe(30)
    const [a] = await dono<{ dados: { antes: { descarteAposHoras: number }; depois: { descarteAposHoras: number } } }[]>`
      SELECT dados FROM auditoria WHERE tenant_id = ${A} AND acao = 'agente.ativas_alteradas'`
    expect(a!.dados).toMatchObject({ antes: { descarteAposHoras: 0 }, depois: { descarteAposHoras: 48 } })
  })

  it('cliente antigo (sem os campos novos) não zera a política de descarte/reativação já salva', async () => {
    const tpl = await novoTemplate('reativacao_bom2', 'APPROVED')
    const reativacao = { ativa: true, dias: [15, 45], templateId: tpl, texto: null }
    await pedir('PUT', URL_ATIVAS, A, { ...corpoValido, descarteAposHoras: 0, reativacao })
    expect((await pedir('PUT', URL_ATIVAS, A, corpoValido)).statusCode).toBe(200)
    expect((await pedir('GET', URL_ATIVAS)).json().config).toMatchObject({ descarteAposHoras: 0, reativacao })
  })

  it('validação da reativação: dias crescentes, 7 a 365, no máximo 3 → 422 no campo', async () => {
    for (const dias of [[90, 30], [3, 30], [30, 400], [7, 30, 90, 180], []]) {
      const r = await pedir('PUT', URL_ATIVAS, A, { ...corpoValido, reativacao: { ativa: false, dias, templateId: null, texto: null } })
      expect(r.statusCode, JSON.stringify(dias)).toBe(422)
      expect(r.json()).toMatchObject({ erro: 'ativas.invalido', campos: ['reativacao'] })
    }
    expect((await pedir('PUT', URL_ATIVAS, A, { ...corpoValido, descarteAposHoras: 9999 })).json()).toMatchObject({ campos: ['descarteAposHoras'] })
    for (const limiteDia of [0, 201, 2.5]) {
      const r = await pedir('PUT', URL_ATIVAS, A, { ...corpoValido, reativacao: { ativa: false, dias: [30, 90], templateId: null, texto: null, limiteDia } })
      expect(r.statusCode, String(limiteDia)).toBe(422)
      expect(r.json()).toMatchObject({ erro: 'ativas.invalido', campos: ['reativacao'] })
    }
  })

  it('⚠️ ligar a reativação no NÃO-OFICIAL exige confirmaRiscoBanimento: true (422 tipificado); já ligada, editar não pede', async () => {
    await dono`INSERT INTO agente_config (tenant_id, canal_id, ativo, modo, politicas, persona, alcada)
               VALUES (${A}, ${SEM_AGENTE}, true, 'sombra', 'x', '{"nome":"Lia","loja":"Loja"}'::jsonb, '{}'::jsonb) ON CONFLICT DO NOTHING`
    try {
      const nao = `/v1/canais/${SEM_AGENTE}/agente/ativas`
      const reativacao = { ativa: true, dias: [30, 90], templateId: null, texto: 'Oi! Posso ajudar?', limiteDia: 20 }
      const sem = await pedir('PUT', nao, A, { ...corpoValido, reativacao })
      expect(sem.statusCode).toBe(422)
      expect(sem.json()).toMatchObject({ erro: 'ativas.confirmar_risco_banimento', campos: ['reativacao'] })
      expect((await pedir('PUT', nao, A, { ...corpoValido, reativacao, confirmaRiscoBanimento: false })).statusCode).toBe(422)
      expect((await pedir('GET', nao)).json().config.reativacao.ativa).toBe(false)   // nada gravado

      const com = await pedir('PUT', nao, A, { ...corpoValido, reativacao, confirmaRiscoBanimento: true })
      expect(com.statusCode).toBe(200)
      expect((await pedir('GET', nao)).json().config.reativacao).toMatchObject({ ativa: true, limiteDia: 20 })
      const [a] = await dono<{ dados: { riscoBanimentoConfirmado?: boolean } }[]>`
        SELECT dados FROM auditoria WHERE tenant_id = ${A} AND acao = 'agente.ativas_alteradas' AND entidade_id = ${SEM_AGENTE}`
      expect(a!.dados.riscoBanimentoConfirmado).toBe(true)
      // Já ligada: mudar o teto não pede de novo.
      expect((await pedir('PUT', nao, A, { ...corpoValido, reativacao: { ...reativacao, limiteDia: 10 } })).statusCode).toBe(200)
      // O oficial não pede confirmação (não carrega o risco do não-oficial).
      const tpl = await novoTemplate('reat_oficial', 'APPROVED')
      expect((await pedir('PUT', URL_ATIVAS, A, { ...corpoValido, reativacao: { ...reativacao, templateId: tpl } })).statusCode).toBe(200)
    } finally {
      await dono`DELETE FROM agente_config WHERE tenant_id = ${A} AND canal_id = ${SEM_AGENTE}`
    }
  })

  it('reativação só em WhatsApp: ligar num Instagram → 422 tipificado', async () => {
    const IG = randomUUID()
    await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado)
               VALUES (${A}, ${IG}, 'instagram', 'meta_oficial', 'Instagram', 'conectado')`
    await dono`INSERT INTO agente_config (tenant_id, canal_id, ativo, modo, politicas, persona, alcada)
               VALUES (${A}, ${IG}, true, 'sombra', 'x', '{"nome":"Lia","loja":"Loja"}'::jsonb, '{}'::jsonb)`
    try {
      const r = await pedir('PUT', `/v1/canais/${IG}/agente/ativas`, A,
        { ...corpoValido, reativacao: { ativa: true, dias: [30, 90], templateId: null, texto: 'Oi!' }, confirmaRiscoBanimento: true })
      expect(r.statusCode).toBe(422)
      expect(r.json()).toMatchObject({ erro: 'ativas.reativacao_canal_incompativel', campos: ['reativacao'] })
    } finally {
      await dono`DELETE FROM agente_config WHERE tenant_id = ${A} AND canal_id = ${IG}`
      await dono`DELETE FROM canal_conectado WHERE tenant_id = ${A} AND id = ${IG}`
    }
  })

  it('ligar a reativação no oficial exige template aprovado e compatível; no não-oficial, texto', async () => {
    const lig = (extra: object) => ({ ...corpoValido, reativacao: { ativa: true, dias: [30, 90], templateId: null, texto: null, ...extra } })
    expect((await pedir('PUT', URL_ATIVAS, A, lig({}))).json()).toMatchObject({ erro: 'ativas.reativacao_sem_conteudo' })
    const pendente = await novoTemplate('reat_pendente', 'PENDING')
    expect((await pedir('PUT', URL_ATIVAS, A, lig({ templateId: pendente }))).json()).toMatchObject({ erro: 'ativas.template_indisponivel' })
    const duas = await novoTemplate('reat_duas', 'APPROVED', 'Oi {{1}} {{2}}')
    expect((await pedir('PUT', URL_ATIVAS, A, lig({ templateId: duas }))).json()).toMatchObject({ erro: 'ativas.template_incompativel' })
    // Não-oficial: texto configurado em vez de template.
    await dono`INSERT INTO agente_config (tenant_id, canal_id, ativo, modo, politicas, persona, alcada)
               VALUES (${A}, ${SEM_AGENTE}, true, 'sombra', 'x', '{"nome":"Lia","loja":"Loja"}'::jsonb, '{}'::jsonb) ON CONFLICT DO NOTHING`
    const nao = `/v1/canais/${SEM_AGENTE}/agente/ativas`
    expect((await pedir('PUT', nao, A, lig({}))).json()).toMatchObject({ erro: 'ativas.reativacao_sem_conteudo' })
    expect((await pedir('PUT', nao, A, { ...lig({ texto: 'Oi! Posso ajudar?' }), confirmaRiscoBanimento: true })).statusCode).toBe(200)
    await dono`DELETE FROM agente_config WHERE tenant_id = ${A} AND canal_id = ${SEM_AGENTE}`
  })

  it('número sem agente configurado → 409 nomeado', async () => {
    const r = await pedir('PUT', `/v1/canais/${SEM_AGENTE}/agente/ativas`, A, corpoValido)
    expect(r.statusCode).toBe(409)
    expect(r.json()).toMatchObject({ erro: 'agente.nao_configurado' })
  })
})

describe('POST /v1/canais/:id/agente/ativas/liberar', () => {
  it('libera a suspensão, resolve o alerta e audita; liberar de novo é 409', async () => {
    await dono`UPDATE canal_conectado SET ativas_suspensas_em = now(), ativas_suspensas_motivo = 'conta:ACCOUNT_VIOLATION' WHERE id = ${CANAL}`
    await dono`INSERT INTO alerta (tenant_id, id, tipo, severidade, mensagem) VALUES (${A}, ${randomUUID()}, 'qualidade_numero', 'critico', 'x')`
    expect((await pedir('POST', `${URL_ATIVAS}/liberar`)).statusCode).toBe(200)
    expect((await pedir('GET', URL_ATIVAS)).json().suspensao).toBeNull()
    const [al] = await dono<{ resolvido_em: Date | null }[]>`SELECT resolvido_em FROM alerta WHERE tenant_id = ${A}`
    expect(al!.resolvido_em).not.toBeNull()
    const [a] = await dono<{ acao: string }[]>`SELECT acao FROM auditoria WHERE tenant_id = ${A}`
    expect(a!.acao).toBe('agente.ativas_liberadas')
    expect((await pedir('POST', `${URL_ATIVAS}/liberar`)).statusCode).toBe(409)
  })
})

describe('GET /v1/canais/:id/agente/ativas/templates', () => {
  it('só aprovados, paginados por cursor', async () => {
    for (let i = 0; i < 22; i++) await novoTemplate(`aprovado_${String(i).padStart(2, '0')}`, 'APPROVED')
    await novoTemplate('rejeitado', 'REJECTED')
    const p1 = (await pedir('GET', `${URL_ATIVAS}/templates`)).json()
    expect(p1.itens).toHaveLength(20)
    expect(p1.proximoCursor).toBeTruthy()
    const p2 = (await pedir('GET', `${URL_ATIVAS}/templates?cursor=${encodeURIComponent(p1.proximoCursor)}`)).json()
    expect(p2.itens.map((t: { nome: string }) => t.nome)).toEqual(['aprovado_20', 'aprovado_21'])
    expect(p2.proximoCursor).toBeNull()
  })
})
