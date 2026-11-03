import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { projetarMes } from '@geracrm/shared'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'
import { custoTranscricao, limitesDoMes, mesValido } from './consumo.js'

/**
 * PREÇOS DO WHATSAPP, MAPEAMENTO DE TEMPLATE E CONSUMO (F2): papel e validação do PUT de preços,
 * mapeamento inválido, consumo com dados semeados em dois tenants, fronteira de mês no FUSO do
 * tenant, projeção e alerta 80/100. Banco real, RLS valendo (papel de aplicação).
 */
describe('regras puras do consumo', () => {
  it('mês válido e limites', () => {
    expect(mesValido('2026-10')).toBe(true)
    expect(mesValido('2026-13')).toBe(false)
    expect(mesValido('26-10')).toBe(false)
    expect(limitesDoMes('2026-12')).toEqual({ inicio: '2026-12-01', fim: '2027-01-01', dias: 31 })
  })
  it('transcrição: 1 h a US$ 0,04 × 5,5 = 22 centavos', () => {
    expect(custoTranscricao(3600, { TRANSCRICAO_USD_POR_HORA: '0.04', IA_CAMBIO_BRL: '5.5' })).toBe(22)
    expect(custoTranscricao(0, {})).toBe(0)
  })
})

const A = 'f2000000-0000-4000-8000-00000000000a'
const B = 'f2000000-0000-4000-8000-00000000000b'
const PV_A = 'f2000000-1111-4000-8000-00000000000a'
const PV_B = 'f2000000-1111-4000-8000-00000000000b'
const PLANO = 'f2000000-3333-4000-8000-000000000001'
const MODELO = 'f2000000-4444-4000-8000-000000000001'
const sufixo = (t: string) => t.slice(-12)
const CANAL = (t: string) => `f2000000-5555-4000-8000-${sufixo(t)}`
const CONTATO = (t: string) => `f2000000-6666-4000-8000-${sufixo(t)}`
const CONVERSA = (t: string) => `f2000000-7777-4000-8000-${sufixo(t)}`
const TPL_MKT = (t: string) => `f2000000-8888-4000-8000-${sufixo(t)}`
const CAMP = (t: string) => `f2000000-9999-4000-8000-${sufixo(t)}`

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const chamar = (t: string, m: 'GET' | 'PUT' | 'PATCH' | 'POST', url: string, corpo?: Record<string, unknown>) =>
  app.inject({ method: m, url, headers: { 'x-tenant-id': t }, ...(corpo ? { payload: corpo } : {}) })

let seq = 0
async function msgSaliente(t: string, criadoEm: string, extra: { template?: boolean; campanha?: boolean; status?: string } = {}) {
  seq += 1
  await dono`
    INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, status, template_id, campanha_id, criado_em)
    VALUES (${t}, ${`f2000000-aaaa-4000-8000-${String(seq).padStart(12, '0')}`}, ${CONVERSA(t)}, 'saliente', 'texto', '{}'::jsonb,
            ${extra.status ?? 'enviada'}, ${extra.template ? TPL_MKT(t) : null}, ${extra.campanha ? CAMP(t) : null}, ${criadoEm}::timestamptz)`
}
async function decisao(t: string, criadoEm: string, centavos: number, modelo = 'claude-sonnet-5-5', modo = 'autonomo') {
  seq += 1
  await dono`
    INSERT INTO agente_decisao (tenant_id, id, conversa_id, canal_id, modo, desfecho, modelo, custo_centavos, criado_em)
    VALUES (${t}, ${`f2000000-bbbb-4000-8000-${String(seq).padStart(12, '0')}`}, ${CONVERSA(t)}, ${CANAL(t)}, ${modo}, 'respondeu',
            ${modelo}, ${centavos}, ${criadoEm}::timestamptz)`
}
async function audio(t: string, criadoEm: string, segundos: number) {
  seq += 1
  await dono`
    INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
    VALUES (${t}, ${`f2000000-cccc-4000-8000-${String(seq).padStart(12, '0')}`}, ${CONVERSA(t)}, 'entrante', 'audio',
            ${JSON.stringify({ transcricao: 'oi', transcricao_duracao_s: segundos })}::text::jsonb, ${criadoEm}::timestamptz)`
}
const atualizarMv = () => dono`SELECT atualizar_consumo_diario()`

async function limpar() {
  for (const tb of ['agente_decisao', 'mensagem', 'campanha', 'template_versao', 'template', 'preco_whatsapp', 'agente_orcamento',
    'auditoria', 'usuario_filial', 'usuario', 'conversa', 'contato', 'canal_conectado']) {
    await dono.unsafe(`DELETE FROM ${tb} WHERE tenant_id IN ('${A}', '${B}')`)
  }
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-f2', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-f2', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[A, PV_A, 'A'], [B, PV_B, 'B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await limpar()
  for (const t of [A, B]) {
    await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES (${t}, ${CANAL(t)}, 'whatsapp_oficial', 'Loja', 'conectado')`
    await dono`INSERT INTO contato (tenant_id, id, nome, ativo) VALUES (${t}, ${CONTATO(t)}, ${`Cliente ${t === A ? 'A' : 'B'}`}, true)`
    await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${t}, ${CONVERSA(t)}, ${CANAL(t)}, ${CONTATO(t)}, 1)`
    await dono`INSERT INTO template (tenant_id, id, nome, categoria) VALUES (${t}, ${TPL_MKT(t)}, 'promo', 'MARKETING')`
    await dono`INSERT INTO template_versao (tenant_id, template_id, versao, corpo, status_meta)
               VALUES (${t}, ${TPL_MKT(t)}, 1, ${JSON.stringify({ body: { texto: 'Olá {{1}}, oferta de {{2}}.' } })}::text::jsonb, 'APPROVED')`
    await dono`INSERT INTO campanha (tenant_id, id, nome, canal_id, mensagem) VALUES (${t}, ${CAMP(t)}, 'Reativação', ${CANAL(t)}, 'oi')`
  }
  // Fuso do A = São Paulo (UTC-3). 2026-10-01T02:30Z = 30/09 23:30 local (SETEMBRO);
  // 2026-10-01T03:30Z = 01/10 00:30 local (OUTUBRO). B em UTC puro: as duas caem em outubro.
  await dono`UPDATE tenant SET fuso = 'America/Sao_Paulo' WHERE id = ${A}`
  await dono`UPDATE tenant SET fuso = 'UTC' WHERE id = ${B}`
  // A — WhatsApp (oficial): 2 marketing de campanha em outubro, 1 utility-like service, 1 na fronteira de setembro, 1 falha (não conta)
  await msgSaliente(A, '2026-10-01T03:30:00Z', { template: true, campanha: true })
  await msgSaliente(A, '2026-10-10T12:00:00Z', { template: true, campanha: true })
  await msgSaliente(A, '2026-10-10T13:00:00Z')
  await msgSaliente(A, '2026-10-01T02:30:00Z', { template: true })
  await msgSaliente(A, '2026-10-11T12:00:00Z', { template: true, status: 'falhou' })
  // A — IA: 600 + 300 centavos em outubro (2 modelos), 50 na fronteira de setembro
  await decisao(A, '2026-10-05T12:00:00Z', 600)
  await decisao(A, '2026-10-06T12:00:00Z', 300, 'claude-haiku-4-5', 'sombra')
  await decisao(A, '2026-10-01T02:30:00Z', 50)
  // A — transcrição: 120 s em outubro
  await audio(A, '2026-10-07T12:00:00Z', 120)
  // B — dados que A nunca pode ver
  await msgSaliente(B, '2026-10-02T12:00:00Z', { template: true, campanha: true })
  await decisao(B, '2026-10-02T12:00:00Z', 9999)
  await atualizarMv()
  app = await criarApp(); await app.ready()
})

afterAll(async () => {
  await limpar()
  for (const t of [A, B]) {
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await atualizarMv()
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('PUT/GET /v1/config/precos-whatsapp', () => {
  const PRECOS = { marketing: 40, utility: 5, authentication: 20, service: 0 }

  it('sem linha devolve o padrão (marcado como tal); PUT grava, audita e GET devolve o gravado', async () => {
    const g0 = (await chamar(A, 'GET', '/v1/config/precos-whatsapp')).json() as { itens: { categoria: string; padrao: boolean }[] }
    expect(g0.itens.every((i) => i.padrao)).toBe(true)
    const r = await chamar(A, 'PUT', '/v1/config/precos-whatsapp', { precos: PRECOS, cambioUsdBrlMilesimos: 5200 })
    expect(r.statusCode).toBe(200)
    const g = (await chamar(A, 'GET', '/v1/config/precos-whatsapp')).json() as {
      itens: { categoria: string; centavosPorMensagem: number; padrao: boolean }[]; cambioUsdBrlMilesimos: number
    }
    expect(g.itens.find((i) => i.categoria === 'marketing')).toMatchObject({ centavosPorMensagem: 40, padrao: false })
    expect(g.cambioUsdBrlMilesimos).toBe(5200)
    const [aud] = await dono<{ n: string }[]>`SELECT count(*)::text AS n FROM auditoria WHERE tenant_id = ${A} AND acao = 'whatsapp.precos_alterados'`
    expect(Number(aud!.n)).toBe(1)
  })

  it('validação 422 por campo: centavo fracionário, negativo, câmbio fora da faixa, chave extra', async () => {
    const ruim = await chamar(A, 'PUT', '/v1/config/precos-whatsapp', { precos: { ...PRECOS, marketing: 1.5, utility: -1 }, cambioUsdBrlMilesimos: 10 })
    expect(ruim.statusCode).toBe(422)
    const j = ruim.json() as { erro: string; campos: Record<string, string> }
    expect(j.erro).toBe('preco.campo_invalido')
    expect(Object.keys(j.campos)).toEqual(expect.arrayContaining(['precos.marketing', 'precos.utility', 'cambioUsdBrlMilesimos']))
    expect((await chamar(A, 'PUT', '/v1/config/precos-whatsapp', { precos: PRECOS, cambioUsdBrlMilesimos: 5500, extra: 1 })).statusCode).toBe(422)
  })

  it('quem não é admin (com admin no tenant) recebe 403; GET segue liberado', async () => {
    const admin = crypto.randomUUID()
    await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${B}, ${admin}, 'sub-admin-f2', 'Bia', 'bia@f2.test')`
    await dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES (${B}, ${admin}, NULL, 'admin')`
    const r = await chamar(B, 'PUT', '/v1/config/precos-whatsapp', { precos: PRECOS, cambioUsdBrlMilesimos: 5500 })
    expect(r.statusCode).toBe(403)
    expect((await chamar(B, 'GET', '/v1/config/precos-whatsapp')).statusCode).toBe(200)
  })

  it('isolamento: o preço de A não aparece em B', async () => {
    const g = (await chamar(B, 'GET', '/v1/config/precos-whatsapp')).json() as { itens: { categoria: string; centavosPorMensagem: number }[] }
    expect(g.itens.find((i) => i.categoria === 'marketing')!.centavosPorMensagem).toBe(35)
  })
})

describe('PATCH /v1/templates/:id/mapeamento', () => {
  const url = (t: string) => `/v1/templates/${TPL_MKT(t)}/mapeamento`

  it('grava o mapeamento válido e o catálogo devolve', async () => {
    const r = await chamar(A, 'PATCH', url(A), { variaveis: { '1': 'contato.nome', '2': 'contato.nome_fantasia' } })
    expect(r.statusCode).toBe(200)
    const lista = (await chamar(A, 'GET', '/v1/templates')).json() as { itens: { id: string; mapeamentoVariaveis: Record<string, string> }[] }
    expect(lista.itens.find((i) => i.id === TPL_MKT(A))!.mapeamentoVariaveis).toEqual({ '1': 'contato.nome', '2': 'contato.nome_fantasia' })
  })

  it('campo fora da lista = 422; variável que o corpo não tem = 422; corpo sem objeto = 422', async () => {
    const campo = await chamar(A, 'PATCH', url(A), { variaveis: { '1': 'contato.cpf' } })
    expect(campo.statusCode).toBe(422)
    expect(campo.json()).toMatchObject({ erro: 'mapeamento.campo_invalido', campos: { 'variaveis.1': expect.any(String) } })
    const variavel = await chamar(A, 'PATCH', url(A), { variaveis: { '3': 'contato.nome' } })
    expect(variavel.statusCode).toBe(422)
    expect(variavel.json()).toMatchObject({ erro: 'mapeamento.variavel_inexistente', campos: { 'variaveis.3': expect.any(String) } })
    expect((await chamar(A, 'PATCH', url(A), { variaveis: 'x' })).statusCode).toBe(422)
  })

  it('template de outro tenant = 404', async () => {
    expect((await chamar(A, 'PATCH', url(B), { variaveis: { '1': 'contato.nome' } })).statusCode).toBe(404)
  })
})

describe('GET /v1/consumo', () => {
  type Consumo = {
    mes: string
    whatsapp: { porCategoria: { categoria: string; mensagens: number; custoCentavos: number }[]; totalCentavos: number }
    ia: {
      porFinalidade: { finalidade: string; custoCentavos: number }[]; porModelo: { modelo: string; custoCentavos: number }[]
      totalCentavos: number; orcamentoCentavos: number | null; projecaoCentavos: number; alerta: null | '80' | '100'
    }
    transcricao: { minutos: number; custoCentavos: number }
    serieDiaria: { dia: string; whatsappCentavos: number; iaCentavos: number; transcricaoCentavos: number }[]
    porCampanha: { nome: string; mensagens: number; custoCentavos: number }[]
    conversasMaisCaras: { conversaId: string; contatoNome: string; custoCentavos: number }[]
  }
  const consumo = async (t: string, mes?: string) => (await chamar(t, 'GET', `/v1/consumo${mes ? `?mes=${mes}` : ''}`)).json() as Consumo

  it('mês inválido = 422', async () => {
    expect((await chamar(A, 'GET', '/v1/consumo?mes=2026-13')).statusCode).toBe(422)
  })

  it('A em outubro: fronteira no fuso do tenant, preço vigente, IA por finalidade e modelo', async () => {
    // preços de A: marketing 40, utility 5, auth 20, service 0 (PUT acima)
    const c = await consumo(A, '2026-10')
    const mkt = c.whatsapp.porCategoria.find((x) => x.categoria === 'marketing')!
    // 01/10 00:30 local e 10/10 entram; 30/09 23:30 local NÃO; a que falhou NÃO.
    expect(mkt.mensagens).toBe(2)
    expect(mkt.custoCentavos).toBe(80)
    expect(c.whatsapp.porCategoria.find((x) => x.categoria === 'service')!.mensagens).toBe(1)
    expect(c.whatsapp.totalCentavos).toBe(80)
    // IA: 600 + 300 (o de 50 caiu em setembro local)
    expect(c.ia.totalCentavos).toBe(900)
    expect(c.ia.porFinalidade).toEqual([
      { finalidade: 'agente_vendedor', turnos: 1, custoCentavos: 600 },
      { finalidade: 'agente_sombra', turnos: 1, custoCentavos: 300 },
    ])
    expect(c.ia.porModelo.map((m) => [m.modelo, m.custoCentavos])).toEqual([['claude-sonnet-5-5', 600], ['claude-haiku-4-5', 300]])
    expect(c.transcricao.minutos).toBe(2)
    expect(c.transcricao.custoCentavos).toBe(custoTranscricao(120))
    expect(c.serieDiaria).toHaveLength(31)
    expect(c.serieDiaria.find((d) => d.dia === '2026-10-01')).toMatchObject({ whatsappCentavos: 40, iaCentavos: 0 })
    expect(c.serieDiaria.find((d) => d.dia === '2026-10-05')!.iaCentavos).toBe(600)
    expect(c.porCampanha).toEqual([{ campanhaId: CAMP(A), nome: 'Reativação', mensagens: 2, custoCentavos: 80 }])
    expect(c.conversasMaisCaras).toEqual([{ conversaId: CONVERSA(A), contatoNome: 'Cliente A', custoCentavos: 900 }])
  })

  it('A em setembro: só a mensagem e a decisão da fronteira (23:30 de 30/09 local)', async () => {
    const c = await consumo(A, '2026-09')
    expect(c.whatsapp.porCategoria.find((x) => x.categoria === 'marketing')!.mensagens).toBe(1)
    expect(c.ia.totalCentavos).toBe(50)
    expect(c.serieDiaria.find((d) => d.dia === '2026-09-30')!.iaCentavos).toBe(50)
  })

  it('isolamento e fuso: B (UTC) vê só os seus dados e usa o preço padrão', async () => {
    const c = await consumo(B, '2026-10')
    expect(c.ia.totalCentavos).toBe(9999)
    expect(c.whatsapp.porCategoria.find((x) => x.categoria === 'marketing')).toMatchObject({ mensagens: 1, custoCentavos: 35 })
    expect(JSON.stringify(c)).not.toContain('Cliente A')
    const a = await consumo(A, '2026-10')
    expect(a.ia.totalCentavos).toBe(900)
  })

  it('alerta 80/100 contra o orçamento mensal de IA e projeção do mês passado', async () => {
    await dono`INSERT INTO agente_orcamento (tenant_id, mensal_centavos) VALUES (${A}, 2000)
               ON CONFLICT (tenant_id) DO UPDATE SET mensal_centavos = 2000`
    expect((await consumo(A, '2026-10')).ia.alerta).toBeNull() // 900 / 2000 = 45%
    await dono`UPDATE agente_orcamento SET mensal_centavos = 1100 WHERE tenant_id = ${A}`
    expect((await consumo(A, '2026-10')).ia.alerta).toBe('80') // 900 / 1100 = 81%
    await dono`UPDATE agente_orcamento SET mensal_centavos = 900 WHERE tenant_id = ${A}`
    const c = await consumo(A, '2026-10')
    expect(c.ia.alerta).toBe('100')
    expect(c.ia.orcamentoCentavos).toBe(900)
    expect(c.ia.projecaoCentavos).toBe(900) // mês fechado: a projeção é o gasto
  })

  it('mês corrente: o dia de hoje vem direto das tabelas (sem esperar o refresh) e a projeção usa o ritmo', async () => {
    const [h] = await dono<{ hoje: string; mes: string }[]>`
      SELECT to_char((now() AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS hoje, to_char((now() AT TIME ZONE 'UTC')::date, 'YYYY-MM') AS mes`
    await decisao(B, new Date().toISOString(), 777)
    // sem refresh: a MV ainda não conhece esta decisão
    const c = await consumo(B, h!.mes)
    expect(c.ia.totalCentavos).toBe(777)
    expect(c.ia.projecaoCentavos).toBe(projetarMes(777, h!.mes, h!.hoje))
    expect(c.serieDiaria.find((d) => d.dia === h!.hoje)!.iaCentavos).toBe(777)
  })
})
