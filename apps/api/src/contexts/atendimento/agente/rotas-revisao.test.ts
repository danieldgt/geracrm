import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { CRITERIOS_RUBRICA, semanaDaData, type CriterioRubrica } from '@geracrm/shared'
import { encerrarBanco } from '../../../db/index.js'
import { pluginTenant } from '../../../plugins/tenant.js'
import { rotasRevisao } from './rotas-revisao.js'
import { rotasQualidade } from './rotas-qualidade.js'
import { falasDaTranscricao } from './revisao-humana.js'

/**
 * REVISÃO HUMANA (ADR-031 §5, raia P16) — dois tenants no banco real.
 * Amostra na ordem da P12 com "revisada ou não", gravação idempotente por
 * revisor, concordância congelada e somada por número, papel exigido e RLS.
 */
const A = 'c0a16000-0000-4000-8000-000000000001'
const B = 'c0a16000-0000-4000-8000-000000000002'
const PV_A = 'c0a16000-1111-4000-8000-000000000001'
const PV_B = 'c0a16000-1111-4000-8000-000000000002'
const PLANO = 'c0a16000-3333-4000-8000-000000000001'
const MODELO = 'c0a16000-4444-4000-8000-000000000001'
const CANAL_A = 'c0a16000-5555-4000-8000-000000000001'
const CANAL_A2 = 'c0a16000-5555-4000-8000-000000000003'
const CANAL_B = 'c0a16000-5555-4000-8000-000000000002'
const U_GESTORA = 'c0a16000-6666-4000-8000-000000000001'
const U_ADMIN = 'c0a16000-6666-4000-8000-000000000002'
const U_VENDEDOR = 'c0a16000-6666-4000-8000-000000000003'
const SUB_ADMIN = 'sub-admin-revisao'
const SUB_VENDEDOR = 'sub-vendedor-revisao'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance

/** Header de teste: troca o sub do usuário (dev usa `dev-<tenant>`). */
const h = (t: string, sub?: string) => ({ 'x-tenant-id': t, ...(sub ? { 'x-teste-sub': sub } : {}) })
const get = (t: string, url: string, sub?: string) => app.inject({ method: 'GET', url, headers: h(t, sub) })
const post = (t: string, payload: unknown, sub?: string) => app.inject({ method: 'POST', url: '/v1/agente/revisao', headers: h(t, sub), payload: payload as object })

const todas = (n: number) => Object.fromEntries(CRITERIOS_RUBRICA.map((c) => [c, n])) as Record<CriterioRubrica, number>
const SEMANA = semanaDaData(new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }))!

/** Uma conversa em sombra com sessão, decisão (a SUGESTÃO), mensagens e as avaliações de regras/juiz. */
async function conversa(t: string, canal: string, p: { pior?: 'CRITICA' | 'ALTA' | 'MEDIA' | null; nota?: number | null } = {}) {
  const contato = crypto.randomUUID(), conv = crypto.randomUUID(), sessao = crypto.randomUUID(), decisao = crypto.randomUUID()
  await dono`INSERT INTO contato (tenant_id, id, nome, ativo) VALUES (${t}, ${contato}, 'Cliente', true)`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${t}, ${conv}, ${canal}, ${contato}, 1)`
  await dono`INSERT INTO agente_sessao (tenant_id, id, conversa_id, canal_id, modo, turnos, estado, encerrada_em, motivo_saida)
             VALUES (${t}, ${sessao}, ${conv}, ${canal}, 'sombra', 1, 'entregue', now(), 'teste')`
  await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
             VALUES (${t}, ${crypto.randomUUID()}, ${conv}, 'entrante', 'texto', '{"texto":"quero caixas, meu fone 85 99999-1234"}'::jsonb, now() - interval '2 minutes')`
  // O vendedor editou a sugestão e enviou outra coisa: a revisão é da SUGESTÃO.
  await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
             VALUES (${t}, ${crypto.randomUUID()}, ${conv}, 'saliente', 'texto', '{"texto":"Texto editado pelo vendedor"}'::jsonb, now() - interval '30 seconds')`
  await dono`INSERT INTO agente_decisao (tenant_id, id, conversa_id, canal_id, sessao_id, modo, desfecho, resposta, criado_em)
             VALUES (${t}, ${decisao}, ${conv}, ${canal}, ${sessao}, 'sombra', 'sugeriu', '{"mensagens":["Temos sim, quantas caixas?"]}'::jsonb, now() - interval '1 minute')`
  let regras: string | null = null, juiz: string | null = null
  if (p.pior !== undefined) {
    regras = crypto.randomUUID()
    const violacoes = p.pior ? [{ regra: 'palavra_proibida', gravidade: p.pior, trecho: 'ligue 85 99999-1234', corrigida: false }] : []
    await dono`INSERT INTO agente_avaliacao (tenant_id, id, decisao_id, conversa_id, canal_id, sessao_id, origem, tipo, gatilho, violacoes, pior_gravidade, acao)
               VALUES (${t}, ${regras}, ${decisao}, ${conv}, ${canal}, ${sessao}, 'sugestao', 'regras', 'turno',
                       ${JSON.stringify(violacoes)}::text::jsonb, ${p.pior}, ${p.pior ? 'registrado' : null})`
  }
  if (p.nota !== undefined && p.nota !== null) {
    juiz = crypto.randomUUID()
    await dono`INSERT INTO agente_avaliacao (tenant_id, id, decisao_id, conversa_id, canal_id, sessao_id, origem, tipo, gatilho, notas, justificativas, nota_media, modelo)
               VALUES (${t}, ${juiz}, ${decisao}, ${conv}, ${canal}, ${sessao}, 'sugestao', 'juiz', 'fim_sessao',
                       ${JSON.stringify(todas(p.nota))}::text::jsonb, ${JSON.stringify(Object.fromEntries(CRITERIOS_RUBRICA.map((c) => [c, 'cliente x@y.com ok'])))}::text::jsonb,
                       ${p.nota}, 'simulado')`
  }
  return { conversa: conv, regras, juiz }
}

async function limpar(t: string): Promise<void> {
  for (const tab of ['agente_revisao', 'agente_avaliacao', 'agente_decisao', 'agente_sessao', 'mensagem', 'conversa', 'contato']) await dono.unsafe(`DELETE FROM ${tab} WHERE tenant_id = '${t}'`)
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-rotas-revisao', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-rotas-revisao', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, canal] of [[A, PV_A, CANAL_A], [B, PV_B, CANAL_B]] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id, fuso) VALUES (${t}, ${`Revisao ${t.slice(-1)}`}, ${PLANO}, ${pv}, 'America/Sao_Paulo') ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
    await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES (${t}, ${canal}, 'whatsapp_nao_oficial', ${`Loja ${t.slice(-1)}`}, 'conectado') ON CONFLICT DO NOTHING`
  }
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES (${A}, ${CANAL_A2}, 'whatsapp_nao_oficial', 'Loja A2', 'conectado') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${A}, ${U_GESTORA}, ${`dev-${A}`}, 'Gina', 'gina@revisao.test') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${A}, ${U_ADMIN}, ${SUB_ADMIN}, 'Ada', 'ada@revisao.test') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${A}, ${U_VENDEDOR}, ${SUB_VENDEDOR}, 'Vito', 'vito@revisao.test') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${B}, ${crypto.randomUUID()}, ${`dev-${B}`}, 'Beto', 'beto@revisao.test') ON CONFLICT DO NOTHING`
  // Papéis atribuídos (sai do modo fundador): admin, gestora e vendedor.
  await dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES (${A}, ${U_ADMIN}, NULL, 'admin')`
  await dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES (${A}, ${U_GESTORA}, NULL, 'gestor')`
  await dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES (${A}, ${U_VENDEDOR}, NULL, 'vendedor')`

  app = Fastify()
  await app.register(pluginTenant)
  app.addHook('preHandler', async (req) => {
    const sub = req.headers['x-teste-sub']
    // E-mail próprio: `garantirUsuarioId` regrava o e-mail, único por tenant.
    if (typeof sub === 'string') { req.usuarioSub = sub; req.usuarioEmail = `${sub}@revisao.test` }
  })
  await app.register(rotasRevisao)
  await app.register(rotasQualidade)
  await app.ready()
})

afterAll(async () => {
  for (const t of [A, B]) {
    await limpar(t)
    for (const tab of ['usuario_filial', 'usuario', 'canal_conectado']) await dono.unsafe(`DELETE FROM ${tab} WHERE tenant_id = '${t}'`)
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('GET /v1/agente/revisao/amostra — 20 por número na ordem da P12', () => {
  it('CRÍTICA → ALTA/nota ≤ 3 (até 8) → aleatórias; avaliação do juiz quando há; estado revisada; só do tenant e do número', async () => {
    await limpar(A); await limpar(B)
    const criticas = new Set<string>(), baixas = new Set<string>()
    for (let i = 0; i < 2; i++) criticas.add((await conversa(A, CANAL_A, { pior: 'CRITICA', nota: 2 })).conversa)
    for (let i = 0; i < 5; i++) baixas.add((await conversa(A, CANAL_A, { pior: 'ALTA' })).conversa)
    for (let i = 0; i < 5; i++) baixas.add((await conversa(A, CANAL_A, { pior: null, nota: 3 })).conversa)
    for (let i = 0; i < 14; i++) await conversa(A, CANAL_A, { pior: null, nota: 5 })
    await conversa(A, CANAL_A2, { pior: 'CRITICA' })
    await conversa(B, CANAL_B, { pior: 'CRITICA' })

    const r = await get(A, `/v1/agente/revisao/amostra?canalId=${CANAL_A}&semana=${SEMANA}`)
    expect(r.statusCode).toBe(200)
    const b = r.json()
    expect(b).toMatchObject({ semana: SEMANA, canalId: CANAL_A, proximoCursor: null })
    expect(b.itens).toHaveLength(20)
    expect(b.itens.map((i: { ordem: number }) => i.ordem)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
    // A MESMA amostra (e ordem) do CSV semanal da P12 — que diz o motivo de cada uma.
    const csv = (await get(A, `/v1/agente/qualidade/amostra-semanal.csv?canalId=${CANAL_A}`)).body.replace(/^\uFEFF/, '').trim().split('\r\n').slice(1).map((l) => l.split(';'))
    expect(csv.map((l) => l[4])).toEqual(b.itens.map((i: { conversaId: string }) => i.conversaId))
    expect(csv.slice(0, 2).every((l) => l[3] === 'critica' && criticas.has(l[4]!))).toBe(true)
    expect(csv.slice(2, 10).every((l) => l[3] === 'alta_ou_nota_baixa' && baixas.has(l[4]!))).toBe(true)
    expect(csv.slice(10).every((l) => l[3] === 'aleatoria')).toBe(true)
    // CEGO antes da 1ª revisão: nada do que o sistema achou sai do servidor (só se há juiz).
    for (const i of b.itens) expect(i).toMatchObject({ cego: true, motivo: null, piorGravidade: null, menorNota: null, notasJuiz: null, revisao: null })
    expect(b.itens[0]).toMatchObject({ comJuiz: true, revisoes: 0, origem: 'sugestao' })
    // A ALTA sem juiz é revisada pela avaliação de regras.
    const altaSemJuiz = b.itens.find((i: { conversaId: string; comJuiz: boolean }) => baixas.has(i.conversaId) && !i.comJuiz)
    expect(altaSemJuiz).toBeTruthy()
    // Estável: pedir de novo dá a mesma ordem; semana atual é o padrão.
    expect((await get(A, `/v1/agente/revisao/amostra?canalId=${CANAL_A}`)).json().itens).toEqual(b.itens)
    // Outro número e outro tenant não aparecem.
    expect(JSON.stringify(b)).not.toContain(CANAL_A2)
    expect((await get(B, `/v1/agente/revisao/amostra?canalId=${CANAL_A}`)).statusCode).toBe(404)
    expect((await get(B, `/v1/agente/revisao/amostra?canalId=${CANAL_B}`)).json().itens).toHaveLength(1)

    // Revisada: aparece no item de quem revisou, e só como contagem para o outro revisor.
    const item = b.itens[0]
    expect((await post(A, { avaliacaoId: item.avaliacaoId, notas: todas(2), gravidade: 'CRITICA', veredito: 'grave', decisao: 'ajustar_prompt', responsavel: 'Time técnico', prazo: '2026-12-01' })).statusCode).toBe(201)
    const depois = (await get(A, `/v1/agente/revisao/amostra?canalId=${CANAL_A}&semana=${SEMANA}`)).json().itens[0]
    expect(depois.revisao).toMatchObject({ veredito: 'grave', concorda: true, motivo: 'critica', revisorNome: 'Gina' })
    // Depois de revisar, o sistema aparece para quem revisou.
    expect(depois).toMatchObject({ cego: false, motivo: 'critica', piorGravidade: 'CRITICA', menorNota: 2, notasJuiz: todas(2), revisoes: 1 })
    const daAdmin = (await get(A, `/v1/agente/revisao/amostra?canalId=${CANAL_A}&semana=${SEMANA}`, SUB_ADMIN)).json().itens[0]
    expect(daAdmin).toMatchObject({ revisao: null, revisoes: 1, cego: true, notasJuiz: null, motivo: null })

    // Planilha da semana: 20 itens (1 linha por revisor), notas do juiz e humanas lado a lado, concordância S/N.
    const pl = await get(A, `/v1/agente/revisao/planilha.csv?canalId=${CANAL_A}&semana=${SEMANA}`)
    expect(pl.statusCode).toBe(200)
    expect(pl.headers['content-disposition']).toContain(`revisao-${SEMANA}.csv`)
    const pls = pl.body.replace(/^﻿/, '').trim().split('\r\n')
    expect(pls).toHaveLength(21)
    const cab = pls[0]!.split(';')
    const l1 = Object.fromEntries(cab.map((c, i) => [c, pls[1]!.split(';')[i]]))
    expect(l1).toMatchObject({ ordem: '1', motivo: 'critica', revisor: 'Gina', nota_juiz_clareza: '2', nota_humana_clareza: '2', concorda: 'S', decisao: 'ajustar_prompt', prazo: '2026-12-01' })
    // Planilha cega como a tela: conversa que quem exporta não revisou sai sem motivo, gravidade e notas do juiz.
    expect(Object.fromEntries(cab.map((c, i) => [c, pls[2]!.split(';')[i]]))).toMatchObject({ motivo: '', gravidade_sistema: '', nota_juiz_clareza: '', revisor: '', concorda: '' })
    const plAdmin = (await get(A, `/v1/agente/revisao/planilha.csv?canalId=${CANAL_A}&semana=${SEMANA}`, SUB_ADMIN)).body.replace(/^\uFEFF/, '').trim().split('\r\n')
    expect(Object.fromEntries(cab.map((c, i) => [c, plAdmin[1]!.split(';')[i]]))).toMatchObject({ motivo: '', revisor: '', nota_humana_clareza: '', nota_juiz_clareza: '' })
    expect((await get(A, `/v1/agente/revisao/planilha.csv?canalId=${CANAL_A}`, SUB_VENDEDOR)).statusCode).toBe(403)
  })

  it('valida semana e canal; semana sem avaliação é vazia', async () => {
    expect((await get(A, `/v1/agente/revisao/amostra?canalId=${CANAL_A}&semana=2026-42`)).statusCode).toBe(422)
    expect((await get(A, `/v1/agente/revisao/amostra?canalId=${CANAL_A}&semana=2025-W53`)).statusCode).toBe(422)
    expect((await get(A, '/v1/agente/revisao/amostra')).statusCode).toBe(422)
    expect((await get(A, `/v1/agente/revisao/amostra?canalId=${CANAL_A}&semana=2020-W10`)).json()).toMatchObject({ semana: '2020-W10', inicio: '2020-03-02', itens: [] })
  })
})

describe('GET /v1/agente/revisao/avaliacoes/:id — o que o revisor lê', () => {
  it('transcrição mascarada com a SUGESTÃO (sombra); cego até revisar; depois notas, justificativas e gravidades', async () => {
    await limpar(A)
    const c = await conversa(A, CANAL_A, { pior: 'ALTA', nota: 3 })
    const r = await get(A, `/v1/agente/revisao/avaliacoes/${c.juiz}`)
    expect(r.statusCode).toBe(200)
    const d = r.json()
    expect(d).toMatchObject({ avaliacaoId: c.juiz, conversaId: c.conversa, semana: SEMANA, origem: 'sugestao', revisao: null,
      cego: true, comJuiz: true, notasJuiz: null, justificativas: null, gravidadeSistema: null })
    expect(d.transcricao.map((f: { autor: string }) => f.autor)).toEqual(['cliente', 'sugestao', 'humano'])
    expect(d.transcricao[1].texto).toBe('Temos sim, quantas caixas?')
    expect(d.violacoes).toEqual([{ regra: 'palavra_proibida', gravidade: null, trecho: 'ligue [telefone]', corrigida: false }])
    expect(JSON.stringify(d)).not.toMatch(/99999|x@y\.com|ALTA/)
    expect((await get(B, `/v1/agente/revisao/avaliacoes/${c.juiz}`)).statusCode).toBe(404)
    await post(A, { avaliacaoId: c.juiz, notas: todas(3), gravidade: 'ALTA', veredito: 'ajustar' })
    const depois = (await get(A, `/v1/agente/revisao/avaliacoes/${c.juiz}`)).json()
    expect(depois).toMatchObject({ cego: false, notasJuiz: todas(3), gravidadeSistema: 'ALTA', violacoes: [{ gravidade: 'ALTA' }] })
    expect(depois.justificativas.clareza).toBe('cliente [e-mail] ok')
    // Outro revisor continua cego.
    expect((await get(A, `/v1/agente/revisao/avaliacoes/${c.juiz}`, SUB_ADMIN)).json()).toMatchObject({ cego: true, notasJuiz: null })
  })

  it('gravidade do sistema vem da MESMA sessão da transcrição, não da conversa na semana', async () => {
    await limpar(A)
    const c = await conversa(A, CANAL_A, { pior: null, nota: 4 })
    // Outra sessão (mais antiga) da mesma conversa, com ALTA nas regras.
    const s2 = crypto.randomUUID(), d2 = crypto.randomUUID()
    await dono`INSERT INTO agente_sessao (tenant_id, id, conversa_id, canal_id, modo, turnos, estado, iniciada_em, encerrada_em, motivo_saida)
               VALUES (${A}, ${s2}, ${c.conversa}, ${CANAL_A}, 'sombra', 1, 'entregue', now() - interval '3 hours', now() - interval '170 minutes', 'teste')`
    await dono`INSERT INTO agente_decisao (tenant_id, id, conversa_id, canal_id, sessao_id, modo, desfecho, resposta, criado_em)
               VALUES (${A}, ${d2}, ${c.conversa}, ${CANAL_A}, ${s2}, 'sombra', 'sugeriu', '{"mensagens":["x"]}'::jsonb, now() - interval '175 minutes')`
    await dono`INSERT INTO agente_avaliacao (tenant_id, id, decisao_id, conversa_id, canal_id, sessao_id, origem, tipo, gatilho, violacoes, pior_gravidade, acao, criado_em)
               VALUES (${A}, ${crypto.randomUUID()}, ${d2}, ${c.conversa}, ${CANAL_A}, ${s2}, 'sugestao', 'regras', 'turno',
                       '[{"regra":"promessa_prazo","gravidade":"ALTA","trecho":"x","corrigida":false}]'::jsonb, 'ALTA', 'registrado', now() - interval '175 minutes')`
    const r = (await post(A, { avaliacaoId: c.juiz, notas: todas(4), gravidade: null, veredito: 'ok' })).json()
    expect(r).toMatchObject({ gravidadeSistema: null, concordaGravidade: true, concorda: true })
    expect((await get(A, `/v1/agente/revisao/avaliacoes/${c.juiz}`)).json().violacoes).toEqual([])
  })

  it('falas: linha de continuação junta na fala anterior; corte marcado', () => {
    expect(falasDaTranscricao('[…]\nCLIENTE: oi\nsegunda linha\nAGENTE: olá')).toEqual({
      cortada: true, falas: [{ autor: 'cliente', texto: 'oi segunda linha' }, { autor: 'agente', texto: 'olá' }],
    })
  })
})

describe('POST /v1/agente/revisao — idempotente por revisor', () => {
  it('regravar do mesmo revisor (201 → 200) só muda veredito/decisão/dono/prazo/observação; outro revisor soma uma linha', async () => {
    await limpar(A)
    const c = await conversa(A, CANAL_A, { pior: null, nota: 4 })
    const corpo = { avaliacaoId: c.juiz, notas: todas(4), gravidade: null, veredito: 'ok' }
    const r1 = await post(A, corpo)
    expect(r1.statusCode).toBe(201)
    expect(r1.json()).toMatchObject({ concorda: true, notasLlm: todas(4), gravidadeSistema: null, decisao: 'nenhuma', semana: SEMANA })
    // Regravar tentando mudar a nota (depois de ver o juiz) NÃO muda o que mede.
    const r2 = await post(A, { ...corpo, notas: { ...todas(4), compliance: 1 }, gravidade: 'CRITICA', veredito: 'grave',
      decisao: 'calibrar_juiz', responsavel: 'Time técnico', prazo: '2026-12-01', observacao: 'rever' })
    expect(r2.statusCode).toBe(200)
    expect(r2.json()).toMatchObject({ id: r1.json().id, veredito: 'grave', decisao: 'calibrar_juiz', responsavel: 'Time técnico', prazo: '2026-12-01', observacao: 'rever',
      notas: todas(4), gravidade: null, concorda: true, falsoNegativoCritica: false, porCriterio: { compliance: true } })
    expect((await post(A, corpo, SUB_ADMIN)).statusCode).toBe(201)
    const [n] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM agente_revisao WHERE tenant_id = ${A} AND avaliacao_id = ${c.juiz}`
    expect(n!.n).toBe(2)
  })

  it('concordância congelada: refazer a avaliação depois não muda a revisão gravada', async () => {
    await limpar(A)
    const c = await conversa(A, CANAL_A, { pior: null, nota: 4 })
    await post(A, { avaliacaoId: c.juiz, notas: todas(4), gravidade: null, veredito: 'ok' })
    await dono`UPDATE agente_avaliacao SET notas = ${JSON.stringify(todas(0))}::text::jsonb WHERE tenant_id = ${A} AND id = ${c.juiz}`
    const d = (await get(A, `/v1/agente/revisao/avaliacoes/${c.juiz}`)).json()
    expect(d.revisao).toMatchObject({ concorda: true, notasLlm: todas(4) })
  })

  it('sem nota do juiz: grava, mas não é comparável; falso negativo CRÍTICO marcado e imutável', async () => {
    await limpar(A)
    const c = await conversa(A, CANAL_A, { pior: null })
    const r = await post(A, { avaliacaoId: c.regras, notas: todas(1), gravidade: 'CRITICA', veredito: 'grave' })
    expect(r.statusCode).toBe(201)
    expect(r.json()).toMatchObject({ concorda: null, notasLlm: null, falsoNegativoCritica: true, concordaGravidade: false })
    // Regravar com "nenhuma" não apaga o falso negativo.
    const r2 = await post(A, { avaliacaoId: c.regras, notas: todas(4), gravidade: null, veredito: 'ok' })
    expect(r2.json()).toMatchObject({ falsoNegativoCritica: true, gravidade: 'CRITICA', notas: todas(1), veredito: 'ok' })
  })

  it('fora da amostra é 422: avaliação que não é a da conversa na amostra, ou conversa que não entrou nas 20', async () => {
    await limpar(A)
    const c = await conversa(A, CANAL_A, { pior: 'MEDIA', nota: 4 })
    // A conversa tem juiz: a avaliação da amostra é a do juiz, não a de regras.
    const r = await post(A, { avaliacaoId: c.regras, notas: todas(4), gravidade: 'MEDIA', veredito: 'ok' })
    expect(r.statusCode).toBe(422)
    expect(r.json()).toMatchObject({ erro: 'revisao.fora_da_amostra' })
    for (let i = 0; i < 21; i++) await conversa(A, CANAL_A, { pior: null, nota: 5 })
    const naAmostra = new Set((await get(A, `/v1/agente/revisao/amostra?canalId=${CANAL_A}`)).json().itens.map((i: { avaliacaoId: string }) => i.avaliacaoId))
    const [fora] = await dono<{ id: string }[]>`
      SELECT id FROM agente_avaliacao WHERE tenant_id = ${A} AND tipo = 'juiz' AND NOT (id = ANY(${[...naAmostra] as string[]}::uuid[])) LIMIT 1`
    expect((await post(A, { avaliacaoId: fora!.id, notas: todas(5), gravidade: null, veredito: 'ok' })).json()).toMatchObject({ erro: 'revisao.fora_da_amostra' })
  })

  it('juiz com erro não põe a conversa na amostra (aqui e no CSV da P12)', async () => {
    await limpar(A)
    const ok = await conversa(A, CANAL_A, { nota: 4 })
    const soErro = await conversa(A, CANAL_A)
    await dono`INSERT INTO agente_avaliacao (tenant_id, id, decisao_id, conversa_id, canal_id, sessao_id, origem, tipo, gatilho, modelo, erro)
               SELECT ${A}, ${crypto.randomUUID()}, d.id, d.conversa_id, d.canal_id, d.sessao_id, 'sugestao', 'juiz', 'fim_sessao', 'simulado', 'timeout'
                 FROM agente_decisao d WHERE d.tenant_id = ${A} AND d.conversa_id = ${soErro.conversa}`
    const itens = (await get(A, `/v1/agente/revisao/amostra?canalId=${CANAL_A}`)).json().itens
    expect(itens.map((i: { conversaId: string }) => i.conversaId)).toEqual([ok.conversa])
    const csv = (await get(A, `/v1/agente/qualidade/amostra-semanal.csv?canalId=${CANAL_A}`)).body
    expect(csv).toContain(ok.conversa)
    expect(csv).not.toContain(soErro.conversa)
  })

  it('valida o corpo; avaliação de outro tenant é 404; tenant no corpo é recusado', async () => {
    await limpar(A); await limpar(B)
    const cb = await conversa(B, CANAL_B, { pior: null, nota: 4 })
    const corpo = { avaliacaoId: cb.juiz, notas: todas(4), gravidade: null, veredito: 'ok' }
    expect((await post(A, corpo)).statusCode).toBe(404)
    expect((await post(A, { ...corpo, tenantId: B })).statusCode).toBe(422)
    expect((await post(A, { ...corpo, veredito: 'talvez' })).statusCode).toBe(422)
    const semDono = await post(A, { ...corpo, decisao: 'nova_regra' })
    expect(semDono.statusCode).toBe(422)
    expect(semDono.json().campos).toEqual(['responsavel', 'prazo'])
    expect((await post(A, { ...corpo, decisao: 'nova_regra', responsavel: 'Ana', prazo: '2026-02-30' })).statusCode).toBe(422)
  })
})

describe('GET /v1/agente/revisao/concordancia — por número', () => {
  it('soma concordantes ÷ comparáveis por número e no total; RLS com dois tenants', async () => {
    await limpar(A); await limpar(B)
    const a1 = await conversa(A, CANAL_A, { pior: null, nota: 4 })
    const a2 = await conversa(A, CANAL_A, { pior: 'ALTA', nota: 4 })
    const a3 = await conversa(A, CANAL_A2, { pior: null, nota: 4 })
    const a4 = await conversa(A, CANAL_A, { pior: null })
    await post(A, { avaliacaoId: a1.juiz, notas: todas(5), gravidade: null, veredito: 'ok' }) // concorda
    await post(A, { avaliacaoId: a2.juiz, notas: todas(4), gravidade: null, veredito: 'ok' }) // gravidade diverge
    await post(A, { avaliacaoId: a3.juiz, notas: todas(3), gravidade: null, veredito: 'ajustar' }) // concorda
    await post(A, { avaliacaoId: a4.regras, notas: todas(3), gravidade: null, veredito: 'ok' }) // não comparável
    // 2º revisor na MESMA conversa a1, discordando: vira linha, mas não conta (uma por conversa e semana — a 1ª).
    await post(A, { avaliacaoId: a1.juiz, notas: todas(0), gravidade: null, veredito: 'grave' }, SUB_ADMIN)
    const b1 = await conversa(B, CANAL_B, { pior: null, nota: 4 })
    await post(B, { avaliacaoId: b1.juiz, notas: todas(0), gravidade: 'CRITICA', veredito: 'grave' })

    const r = (await get(A, `/v1/agente/revisao/concordancia?semana=${SEMANA}`)).json()
    expect(r).toMatchObject({ semana: SEMANA, canalId: null, meta: 0.85, minimoRevisadas: 20, revisoes: 5, revisadas: 4, comparaveis: 3, conversasComparaveis: 3, concordantes: 2, concordancia: 0.6667, atingeMeta: false })
    expect(r.porCriterio.clareza).toBe(1)
    expect(r.porNumero.map((n: { canalId: string; revisadas: number; concordancia: number | null }) => [n.canalId, n.revisadas, n.concordancia]))
      .toEqual([[CANAL_A, 3, 0.5], [CANAL_A2, 1, 1]])
    const so = (await get(A, `/v1/agente/revisao/concordancia?canalId=${CANAL_A2}`)).json()
    expect(so).toMatchObject({ canalId: CANAL_A2, revisadas: 1, porNumero: [{ canalId: CANAL_A2, nome: 'Loja A2' }] })
    // Outro tenant: só vê a própria revisão; o canal de A não existe para ele.
    expect((await get(B, `/v1/agente/revisao/concordancia?semana=${SEMANA}`)).json()).toMatchObject({ revisadas: 1, comparaveis: 1, concordantes: 0, falsosNegativosCritica: 1 })
    expect((await get(B, `/v1/agente/revisao/concordancia?canalId=${CANAL_A}`)).json()).toMatchObject({ revisadas: 0, porNumero: [] })
    // RLS direto no banco: o papel da API sob o tenant B não lê linha de A.
    const api = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} })
    try {
      const linhas = await api.begin(async (tx) => {
        await tx`SELECT set_config('geracrm.tenant_id', ${B}, true)`
        return tx<{ tenant_id: string }[]>`SELECT tenant_id FROM agente_revisao`
      })
      expect(linhas.every((l) => l.tenant_id === B)).toBe(true)
      expect(linhas).toHaveLength(1)
    } finally { await api.end() }
    expect((await get(A, '/v1/agente/revisao/concordancia?semana=xx')).statusCode).toBe(422)
  })
})

describe('Papel exigido: gestor ou admin', () => {
  it('vendedor recebe 403 em todas as rotas; gestora e admin passam; sem tenant 401', async () => {
    await limpar(A)
    const c = await conversa(A, CANAL_A, { pior: null, nota: 4 })
    const corpo = { avaliacaoId: c.juiz, notas: todas(4), gravidade: null, veredito: 'ok' }
    for (const r of [
      await get(A, `/v1/agente/revisao/amostra?canalId=${CANAL_A}`, SUB_VENDEDOR),
      await get(A, `/v1/agente/revisao/avaliacoes/${c.juiz}`, SUB_VENDEDOR),
      await get(A, '/v1/agente/revisao/concordancia', SUB_VENDEDOR),
      await post(A, corpo, SUB_VENDEDOR),
    ]) {
      expect(r.statusCode).toBe(403)
      expect(r.json()).toMatchObject({ erro: 'acesso.papel_insuficiente', exige: ['admin', 'gestor'] })
    }
    expect((await get(A, '/v1/agente/revisao/concordancia')).statusCode).toBe(200)
    expect((await get(A, '/v1/agente/revisao/concordancia', SUB_ADMIN)).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/v1/agente/revisao/concordancia' })).statusCode).toBe(401)
  })
})
