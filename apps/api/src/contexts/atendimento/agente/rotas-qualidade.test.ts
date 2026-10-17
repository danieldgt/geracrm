import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { CRITERIOS_RUBRICA } from '@geracrm/shared'
import { encerrarBanco } from '../../../db/index.js'
import { pluginTenant } from '../../../plugins/tenant.js'
import type { PortaLlmFerramentas, ResultadoLaco } from './porta-llm.js'
import { celulaCsv, rotasQualidade } from './rotas-qualidade.js'

/**
 * ROTAS DE QUALIDADE (ADR-031, raia P12) — dois tenants no banco real.
 * Lista por cursor, resumo, CSV da amostra semanal (ordem e máscara), juiz sob
 * demanda com porta falsa, configuração do número (admin + auditoria) e isolamento.
 */
const A = 'c0a13000-0000-4000-8000-000000000001'
const B = 'c0a13000-0000-4000-8000-000000000002'
const PV_A = 'c0a13000-1111-4000-8000-000000000001'
const PV_B = 'c0a13000-1111-4000-8000-000000000002'
const PLANO = 'c0a13000-3333-4000-8000-000000000001'
const MODELO = 'c0a13000-4444-4000-8000-000000000001'
const CANAL_A = 'c0a13000-5555-4000-8000-000000000001'
const CANAL_B = 'c0a13000-5555-4000-8000-000000000002'
const U_A = 'c0a13000-6666-4000-8000-000000000001'
const U_A_ADMIN = 'c0a13000-6666-4000-8000-000000000002'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
let chamadasJuiz = 0
const juizFalso: PortaLlmFerramentas = {
  nome: 'simulado', capacidades: { ferramentas: false, saidaEstruturada: true, cacheDePrefixo: false },
  async rodar(): Promise<ResultadoLaco> {
    chamadasJuiz++
    return { ok: true, saida: Object.fromEntries(CRITERIOS_RUBRICA.map((c) => [c, { nota: 2, justificativa: 'fraco' }])),
      rastro: { chamadas: [], rodadas: 1, uso: { entrada: 0, saida: 0, cacheLeitura: 0, cacheEscrita: 0 }, modelo: 'simulado', provedor: 'simulado', latenciaMs: 1, parouPor: 'fim' } }
  },
}

const h = (t: string) => ({ 'x-tenant-id': t })
const get = (t: string, url: string) => app.inject({ method: 'GET', url, headers: h(t) })

/** Uma conversa com sessão encerrada e UMA decisão; opcionalmente a avaliação de regras e/ou de juiz. */
async function conversa(t: string, canal: string, p: {
  pior?: 'CRITICA' | 'ALTA' | 'MEDIA' | null; nota?: number | null; trecho?: string; criado?: string
} = {}): Promise<{ conversa: string; decisao: string }> {
  const contato = crypto.randomUUID(), conv = crypto.randomUUID(), sessao = crypto.randomUUID(), decisao = crypto.randomUUID()
  await dono`INSERT INTO contato (tenant_id, id, nome, ativo) VALUES (${t}, ${contato}, 'Cliente', true)`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${t}, ${conv}, ${canal}, ${contato}, 1)`
  await dono`INSERT INTO agente_sessao (tenant_id, id, conversa_id, canal_id, modo, turnos, estado, encerrada_em, motivo_saida)
             VALUES (${t}, ${sessao}, ${conv}, ${canal}, 'sombra', 1, 'entregue', now(), 'teste')`
  await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo) VALUES (${t}, ${crypto.randomUUID()}, ${conv}, 'entrante', 'texto', '{"texto":"quero caixas"}'::jsonb)`
  await dono`INSERT INTO agente_decisao (tenant_id, id, conversa_id, canal_id, sessao_id, modo, desfecho, resposta)
             VALUES (${t}, ${decisao}, ${conv}, ${canal}, ${sessao}, 'sombra', 'sugeriu', '{"mensagens":["Temos sim, quantas?"]}'::jsonb)`
  const criado = p.criado ?? new Date().toISOString()
  if (p.pior !== undefined) {
    const violacoes = p.pior ? [{ regra: 'palavra_proibida', gravidade: p.pior, trecho: p.trecho ?? 'trecho', corrigida: false }] : []
    await dono`INSERT INTO agente_avaliacao (tenant_id, id, decisao_id, conversa_id, canal_id, sessao_id, origem, tipo, gatilho, violacoes, pior_gravidade, acao, criado_em)
               VALUES (${t}, ${crypto.randomUUID()}, ${decisao}, ${conv}, ${canal}, ${sessao}, 'sugestao', 'regras', 'turno',
                       ${JSON.stringify(violacoes)}::text::jsonb, ${p.pior}, ${p.pior ? 'registrado' : null}, ${criado})`
  }
  if (p.nota !== undefined && p.nota !== null) {
    const notas = Object.fromEntries(CRITERIOS_RUBRICA.map((c) => [c, p.nota]))
    const just = Object.fromEntries(CRITERIOS_RUBRICA.map((c) => [c, 'cliente 85 99999-1234 pediu prazo']))
    await dono`INSERT INTO agente_avaliacao (tenant_id, id, decisao_id, conversa_id, canal_id, sessao_id, origem, tipo, gatilho, notas, justificativas, nota_media, modelo, custo_centavos, criado_em)
               VALUES (${t}, ${crypto.randomUUID()}, ${decisao}, ${conv}, ${canal}, ${sessao}, 'sugestao', 'juiz', 'fim_sessao',
                       ${JSON.stringify(notas)}::text::jsonb, ${JSON.stringify(just)}::text::jsonb, ${p.nota}, 'simulado', 7, ${criado})`
  }
  return { conversa: conv, decisao }
}

async function limpar(t: string): Promise<void> {
  for (const tab of ['agente_avaliacao', 'agente_decisao', 'agente_sessao', 'mensagem', 'conversa', 'contato', 'alerta', 'outbox']) await dono.unsafe(`DELETE FROM ${tab} WHERE tenant_id = '${t}'`)
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-rotas-qualidade', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-rotas-qualidade', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, canal] of [[A, PV_A, CANAL_A], [B, PV_B, CANAL_B]] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${`Qualidade R ${t.slice(-1)}`}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
    await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES (${t}, ${canal}, 'whatsapp_nao_oficial', ${`Loja ${t.slice(-1)}`}, 'conectado') ON CONFLICT DO NOTHING`
    await dono`INSERT INTO agente_config (tenant_id, canal_id, ativo, modo, politicas) VALUES (${t}, ${canal}, true, 'sombra', 'Políticas.') ON CONFLICT DO NOTHING`
  }
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${A}, ${U_A}, ${`dev-${A}`}, 'Vera', 'vera@qualidade.test') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${A}, ${U_A_ADMIN}, 'sub-admin-qualidade', 'Ada', 'ada@qualidade.test') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${B}, ${crypto.randomUUID()}, ${`dev-${B}`}, 'Beto', 'beto@qualidade.test') ON CONFLICT DO NOTHING`

  app = Fastify()
  await app.register(pluginTenant)
  await app.register(rotasQualidade, { juiz: juizFalso })
  await app.ready()
})

afterAll(async () => {
  for (const t of [A, B]) {
    await limpar(t)
    for (const tab of ['auditoria', 'agente_config', 'usuario_filial', 'usuario', 'canal_conectado']) await dono.unsafe(`DELETE FROM ${tab} WHERE tenant_id = '${t}'`)
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('GET /v1/agente/qualidade — lista por cursor', () => {
  it('pagina de 20 em 20 sem repetir, filtra, e não mostra o outro tenant', async () => {
    await limpar(A); await limpar(B)
    for (let i = 0; i < 23; i++) await conversa(A, CANAL_A, { pior: i < 2 ? 'CRITICA' : null })
    await conversa(B, CANAL_B, { pior: 'CRITICA' })
    const p1 = (await get(A, '/v1/agente/qualidade')).json()
    expect(p1.itens).toHaveLength(20)
    expect(p1.proximoCursor).toBeTruthy()
    const p2 = (await get(A, `/v1/agente/qualidade?cursor=${p1.proximoCursor}`)).json()
    expect(p2.itens).toHaveLength(3)
    expect(p2.proximoCursor).toBeNull()
    const ids = [...p1.itens, ...p2.itens].map((x: { id: string }) => x.id)
    expect(new Set(ids).size).toBe(23)
    expect((await get(A, '/v1/agente/qualidade?gravidade=CRITICA')).json().itens).toHaveLength(2)
    expect((await get(A, `/v1/agente/qualidade?canalId=${CANAL_B}`)).json().itens).toEqual([])
    expect((await get(B, '/v1/agente/qualidade')).json().itens).toHaveLength(1)
    expect((await get(A, '/v1/agente/qualidade?cursor=lixo')).statusCode).toBe(422)
    expect((await get(A, '/v1/agente/qualidade?tenantId=x')).statusCode).toBe(422)
    expect((await app.inject({ method: 'GET', url: '/v1/agente/qualidade' })).statusCode).toBe(401)
  })
})

describe('GET /v1/agente/qualidade/resumo', () => {
  it('conta por gravidade e regra, média do juiz, amostra e teto do número', async () => {
    await limpar(A)
    await conversa(A, CANAL_A, { pior: 'CRITICA', nota: 2 })
    await conversa(A, CANAL_A, { pior: 'ALTA', nota: 4 })
    await conversa(A, CANAL_A, { pior: null })
    const r = (await get(A, `/v1/agente/qualidade/resumo?canalId=${CANAL_A}`)).json()
    expect(r).toMatchObject({
      periodoDias: 7, turnosAvaliados: 3, porGravidade: { CRITICA: 1, ALTA: 1, MEDIA: 0 }, julgadas: 2, notaMedia: 3,
      porRegra: [{ regra: 'palavra_proibida', quantidade: 2 }], amostra: null, amostraPadrao: 1,
      juiz: { disponivel: true, gastoMesCentavos: 14, tetoMesCentavos: 2000, pausadoPorTeto: false },
    })
    expect(r.mediaPorCriterio.compliance).toBe(3)
    expect((await get(B, `/v1/agente/qualidade/resumo?canalId=${CANAL_A}`)).json()).toMatchObject({ turnosAvaliados: 0 })
  })
})

describe('GET /v1/agente/qualidade/amostra-semanal.csv', () => {
  it('ordem CRÍTICA → ALTA/nota ≤ 3 (até 8) → aleatórias até 20, mascarado e só do tenant', async () => {
    await limpar(A); await limpar(B)
    const criticas = new Set<string>()
    for (let i = 0; i < 3; i++) criticas.add((await conversa(A, CANAL_A, { pior: 'CRITICA', trecho: 'liga 85 99999-1234 ou x@y.com' })).conversa)
    const baixas = new Set<string>()
    for (let i = 0; i < 6; i++) baixas.add((await conversa(A, CANAL_A, { pior: 'ALTA' })).conversa)
    for (let i = 0; i < 5; i++) baixas.add((await conversa(A, CANAL_A, { pior: null, nota: 2 })).conversa)
    for (let i = 0; i < 15; i++) await conversa(A, CANAL_A, { pior: null, nota: 5 })
    await conversa(B, CANAL_B, { pior: 'CRITICA' })
    // Nome do número com telefone: sai mascarado no CSV também.
    await dono`UPDATE canal_conectado SET nome_amigavel = 'Loja 85 99999-1234' WHERE tenant_id = ${A} AND id = ${CANAL_A}`

    const r = await get(A, '/v1/agente/qualidade/amostra-semanal.csv')
    expect(r.statusCode).toBe(200)
    expect(r.headers['content-type']).toMatch(/text\/csv/)
    expect(r.headers['content-disposition']).toMatch(/qualidade-amostra-\d{4}-W\d{2}\.csv/)
    const linhas = r.body.replace(/^﻿/, '').trim().split('\r\n')
    expect(linhas[0]).toBe('semana;numero;ordem;motivo;conversa_id;pior_gravidade;menor_nota;avaliacoes;violacoes;justificativas_juiz')
    const dados = linhas.slice(1).map((l) => l.split(';'))
    expect(dados).toHaveLength(20)
    expect(dados.slice(0, 3).every((c) => c[3] === 'critica' && criticas.has(c[4]!))).toBe(true)
    expect(dados.slice(3, 11).every((c) => c[3] === 'alta_ou_nota_baixa' && baixas.has(c[4]!))).toBe(true)
    expect(dados.slice(11).every((c) => c[3] === 'aleatoria')).toBe(true)
    expect(dados.map((c) => c[2])).toEqual(Array.from({ length: 20 }, (_, i) => String(i + 1)))
    expect(r.body).not.toMatch(/99999|x@y\.com|5585/)
    expect(r.body).toMatch(/\[telefone\]/)
    expect(r.body).not.toContain(CANAL_B)
    // Estável: exportar de novo dá o mesmo arquivo.
    expect((await get(A, '/v1/agente/qualidade/amostra-semanal.csv')).body).toBe(r.body)
    expect((await get(A, '/v1/agente/qualidade/amostra-semanal.csv?inicio=ontem')).statusCode).toBe(422)
    expect(dados[0]![1]).toBe('Loja [telefone]')
    await dono`UPDATE canal_conectado SET nome_amigavel = 'Loja A' WHERE tenant_id = ${A} AND id = ${CANAL_A}`
  })

  it('célula protege contra fórmula e escapa aspas e separador', () => {
    expect(celulaCsv('=SOMA(A1)')).toBe("'=SOMA(A1)")
    expect(celulaCsv('a;b "c"')).toBe('"a;b ""c"""')
    expect(celulaCsv(null)).toBe('')
  })
})

describe('POST /v1/agente/qualidade/avaliar — juiz sob demanda', () => {
  it('julga a conversa fora da amostra, uma vez; de outro tenant é 404', async () => {
    await limpar(A)
    chamadasJuiz = 0
    const { conversa: conv } = await conversa(A, CANAL_A)
    const r = await app.inject({ method: 'POST', url: '/v1/agente/qualidade/avaliar', headers: h(A), payload: { conversaId: conv } })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ desfecho: 'avaliada', avaliacao: { tipo: 'juiz', gatilho: 'manual', notaMedia: 2, notas: { clareza: { nota: 2, justificativa: 'fraco' } } } })
    const de2 = await app.inject({ method: 'POST', url: '/v1/agente/qualidade/avaliar', headers: h(A), payload: { conversaId: conv } })
    expect(de2.json()).toMatchObject({ desfecho: 'ja_avaliada' })
    expect(chamadasJuiz).toBe(1)
    expect((await app.inject({ method: 'POST', url: '/v1/agente/qualidade/avaliar', headers: h(B), payload: { conversaId: conv } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: '/v1/agente/qualidade/avaliar', headers: h(A), payload: { conversaId: 'x' } })).statusCode).toBe(422)
  })
})

describe('POST /v1/agente/qualidade/avaliar — a sessão do item', () => {
  it('com decisaoId julga a sessão daquela decisão, não a mais recente', async () => {
    await limpar(A)
    const { conversa: conv, decisao: recente } = await conversa(A, CANAL_A)
    // Uma sessão ANTERIOR na mesma conversa, com a sua decisão.
    const antiga = crypto.randomUUID(), decAntiga = crypto.randomUUID()
    await dono`INSERT INTO agente_sessao (tenant_id, id, conversa_id, canal_id, modo, turnos, estado, encerrada_em, motivo_saida, iniciada_em)
               VALUES (${A}, ${antiga}, ${conv}, ${CANAL_A}, 'sombra', 1, 'encerrada', now() - interval '2 days', 'teste', now() - interval '3 days')`
    await dono`INSERT INTO agente_decisao (tenant_id, id, conversa_id, canal_id, sessao_id, modo, desfecho, resposta, criado_em)
               VALUES (${A}, ${decAntiga}, ${conv}, ${CANAL_A}, ${antiga}, 'sombra', 'sugeriu', '{"mensagens":["Bom dia, posso ajudar?"]}'::jsonb, now() - interval '3 days')`
    await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em) VALUES (${A}, ${crypto.randomUUID()}, ${conv}, 'entrante', 'texto', '{"texto":"oi"}'::jsonb, now() - interval '3 days')`
    const r = await app.inject({ method: 'POST', url: '/v1/agente/qualidade/avaliar', headers: h(A), payload: { conversaId: conv, decisaoId: decAntiga } })
    expect(r.statusCode).toBe(200)
    expect(r.json().avaliacao).toMatchObject({ decisaoId: decAntiga, sessaoId: antiga })
    const semItem = await app.inject({ method: 'POST', url: '/v1/agente/qualidade/avaliar', headers: h(A), payload: { conversaId: conv } })
    expect(semItem.json().avaliacao).toMatchObject({ decisaoId: recente })
  })
})

describe('GET/PUT /v1/canais/:id/agente/qualidade', () => {
  it('admin grava amostra e teto com auditoria; valida; outro tenant 404', async () => {
    const r = await app.inject({ method: 'PUT', url: `/v1/canais/${CANAL_A}/agente/qualidade`, headers: h(A), payload: { amostra: 0.25, tetoMesCentavos: 500 } })
    expect(r.statusCode).toBe(200)
    expect((await get(A, `/v1/canais/${CANAL_A}/agente/qualidade`)).json()).toMatchObject({ amostra: 0.25, amostraPadrao: 1, tetoMesCentavos: 500, tetoMesEfetivoCentavos: 500 })
    const [aud] = await dono<{ dados: { antes: unknown; depois: unknown } }[]>`
      SELECT dados FROM auditoria WHERE tenant_id = ${A} AND acao = 'agente.qualidade_alterada' ORDER BY criado_em DESC LIMIT 1`
    expect(aud!.dados).toEqual({ antes: { amostra: null, tetoMesCentavos: null }, depois: { amostra: 0.25, tetoMesCentavos: 500 } })
    expect((await app.inject({ method: 'PUT', url: `/v1/canais/${CANAL_A}/agente/qualidade`, headers: h(A), payload: { amostra: 2, tetoMesCentavos: null } })).statusCode).toBe(422)
    expect((await app.inject({ method: 'PUT', url: `/v1/canais/${CANAL_A}/agente/qualidade`, headers: h(B), payload: { amostra: 1, tetoMesCentavos: null } })).statusCode).toBe(404)
    expect((await get(B, `/v1/canais/${CANAL_A}/agente/qualidade`)).statusCode).toBe(404)
  })

  it('com admin atribuído, quem não é admin não grava nem exporta (403)', async () => {
    await dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES (${A}, ${U_A_ADMIN}, NULL, 'admin')`
    await dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES (${A}, ${U_A}, NULL, 'vendedor')`
    expect((await app.inject({ method: 'PUT', url: `/v1/canais/${CANAL_A}/agente/qualidade`, headers: h(A), payload: { amostra: 1, tetoMesCentavos: null } })).statusCode).toBe(403)
    expect((await get(A, '/v1/agente/qualidade/amostra-semanal.csv')).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: '/v1/agente/qualidade/avaliar', headers: h(A), payload: { conversaId: crypto.randomUUID() } })).statusCode).toBe(403)
    // Leitura continua aberta a quem é do tenant.
    expect((await get(A, '/v1/agente/qualidade')).statusCode).toBe(200)
  })
})
