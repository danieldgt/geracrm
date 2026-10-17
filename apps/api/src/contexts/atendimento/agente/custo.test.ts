import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../../app.js'
import { comTenantServico, encerrarBanco } from '../../../db/index.js'
import {
  normalizarIdModelo, ehVarianteGratuita, resolverPreco, precoDoModelo, centavosDoUso, custoDoLaco, maiorPreco,
  catalogoDePrecos, limparCacheDeCusto, limiarAtingido, verificarOrcamentoMensal, tetoSessaoEfetivo,
  type LinhaPreco,
} from './custo.js'

/**
 * CUSTO (ADR-032, raia P6): normalização do id, preço pelo catálogo `modelo_ia`
 * (gratuito = 0, desconhecido = maior preço + alerta), orçamento mensal com
 * alerta 80/100% uma vez por mês, e RLS com dois tenants.
 */

describe('normalizarIdModelo', () => {
  it.each([
    ['openai/gpt-oss-120b', 'gpt-oss-120b'],
    ['claude-sonnet-5-5', 'claude-sonnet-5-5'],
    ['us.anthropic.claude-sonnet-5-5-20260101-v1:0', 'claude-sonnet-5-5'],
    ['global.anthropic.claude-opus-5-5', 'claude-opus-5-5'],
    ['eu.anthropic.claude-haiku-4-5-v1:0', 'claude-haiku-4-5'],
    ['us-gov.anthropic.claude-sonnet-5-5', 'claude-sonnet-5-5'],
    ['anthropic.claude-opus-5-5-v1:0', 'claude-opus-5-5'],
    ['arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-5-5-20260101-v1:0', 'claude-sonnet-5-5'],
    ['qwen/qwen3-coder:free', 'qwen3-coder'],
    ['meta-llama/llama-3.3-70b-instruct:nitro', 'llama-3-3-70b-instruct'],
    ['claude-haiku-4-5@20251001', 'claude-haiku-4-5'],
    ['claude-haiku-4-5-20251001', 'claude-haiku-4-5'],
    ['gpt-oss-120b-2025-10-01', 'gpt-oss-120b'],
    ['anthropic/claude-sonnet-5.5', 'claude-sonnet-5-5'],
    ['models/gemini-2.5-flash', 'gemini-2-5-flash'],
    ['  Claude-Opus-5-5-latest ', 'claude-opus-5-5'],
    ['deepseek/deepseek-v3', 'deepseek-v3'],
    ['deepseek-v2', 'deepseek-v2'],
    ['acme-modelo-v2:1', 'acme-modelo'],
  ])('%s → %s', (bruto, base) => {
    expect(normalizarIdModelo(bruto)).toBe(base)
    expect(normalizarIdModelo(base)).toBe(base) // idempotente
  })

  it('deepseek-v2 e deepseek-v3 continuam distintos (só -vN:M é versão do Bedrock)', () => {
    expect(normalizarIdModelo('deepseek-v2')).not.toBe(normalizarIdModelo('deepseek-v3'))
  })

  it(':free é variante gratuita; :nitro não', () => {
    expect(ehVarianteGratuita('qwen/qwen3-coder:free')).toBe(true)
    expect(ehVarianteGratuita('meta-llama/llama-3.3-70b-instruct:nitro')).toBe(false)
  })
})

describe('resolverPreco (catálogo em memória)', () => {
  const CAT: LinhaPreco[] = [
    { codigo: 'claude-sonnet-5-5', provedor: 'claude', modelo: 'claude-sonnet-5-5', gratuito: false, entrada: 2, saida: 10, cacheLeitura: 0.2, cacheEscrita: 2.5 },
    { codigo: 'claude-opus-5-5', provedor: 'claude', modelo: 'claude-opus-5-5', gratuito: false, entrada: 4, saida: 20, cacheLeitura: 0.2, cacheEscrita: 5 },
    { codigo: 'groq-gpt-oss-120b', provedor: 'groq', modelo: 'openai/gpt-oss-120b', gratuito: true, entrada: 0.15, saida: 0.6, cacheLeitura: null, cacheEscrita: null },
    { codigo: 'maritaca-sabia-3-1', provedor: 'maritaca', modelo: 'sabia-3.1', gratuito: false, entrada: 1, saida: 2, cacheLeitura: null, cacheEscrita: null },
  ]

  it('Groq gratuito custa 0 (id que o Groq devolve, com prefixo openai/)', () => {
    const r = resolverPreco(CAT, { provedor: 'groq', modelo: 'openai/gpt-oss-120b' })
    expect(r.origem).toBe('gratuito')
    expect(centavosDoUso(r.preco, { entrada: 5_000_000, saida: 1_000_000, cacheLeitura: 0, cacheEscrita: 0 })).toBe(0)
  })

  it('o mesmo modelo noutro provedor NÃO herda o gratuito (o plano grátis é do provedor)', () => {
    const r = resolverPreco(CAT, { provedor: 'openrouter', modelo: 'openai/gpt-oss-120b' })
    expect(r.origem).toBe('catalogo')
    expect(r.preco.saida).toBe(0.6)
  })

  it('Bedrock com perfil, data e versão acha o Sonnet; Vertex com @data também', () => {
    for (const id of ['us.anthropic.claude-sonnet-5-5-20260101-v1:0', 'global.anthropic.claude-sonnet-5-5', 'claude-sonnet-5-5@20260101']) {
      const r = resolverPreco(CAT, { provedor: 'claude', modelo: id })
      expect(r).toMatchObject({ origem: 'catalogo', codigo: 'claude-sonnet-5-5' })
    }
  })

  it(':free do catálogo NÃO contamina o modelo pago de mesmo nome', () => {
    const comFree: LinhaPreco[] = [...CAT,
      { codigo: 'openrouter-qwen3-coder-free', provedor: 'openrouter', modelo: 'qwen/qwen3-coder:free', gratuito: true, entrada: 0, saida: 0, cacheLeitura: null, cacheEscrita: null }]
    expect(resolverPreco(comFree, { provedor: 'openrouter', modelo: 'qwen/qwen3-coder:free' }).origem).toBe('gratuito')
    const pago = resolverPreco(comFree, { provedor: 'openrouter', modelo: 'qwen/qwen3-coder' })
    expect(pago.origem).toBe('desconhecido')
    expect(pago.preco).toEqual(maiorPreco(comFree))
    expect(resolverPreco(comFree, { provedor: null, modelo: 'qwen/qwen3-coder' }).origem).toBe('desconhecido')
  })

  it(':free custa 0 mesmo fora do catálogo; simulado custa 0', () => {
    expect(resolverPreco(CAT, { provedor: 'openrouter', modelo: 'qualquer/coisa:free' }).origem).toBe('gratuito')
    expect(resolverPreco(CAT, { provedor: 'simulado', modelo: 'simulado' }).origem).toBe('gratuito')
  })

  it('desconhecido = maior preço do catálogo (componente a componente), nunca 0', () => {
    const r = resolverPreco(CAT, { provedor: 'openrouter', modelo: 'mistral/mistral-large-2511' })
    expect(r.origem).toBe('desconhecido')
    expect(r.preco).toEqual({ entrada: 4, saida: 20, cacheLeitura: 1, cacheEscrita: 5 }) // leitura: Sabiá sem preço de cache = entrada (1)
    expect(maiorPreco(CAT)).toEqual(r.preco)
  })

  it('cache sem preço próprio cobra como entrada (errar para cima)', () => {
    const r = resolverPreco(CAT, { provedor: 'maritaca', modelo: 'sabia-3.1' })
    expect(r.preco).toEqual({ entrada: 1, saida: 2, cacheLeitura: 1, cacheEscrita: 1 })
  })

  it('centavos inteiros: 1M de entrada no Sonnet = US$ 2 × 5,5 = R$ 11,00', () => {
    const r = resolverPreco(CAT, { provedor: 'claude', modelo: 'claude-sonnet-5-5' })
    expect(centavosDoUso(r.preco, { entrada: 1_000_000, saida: 0, cacheLeitura: 0, cacheEscrita: 0 }, 5.5)).toBe(1100)
    expect(centavosDoUso(r.preco, { entrada: 0, saida: 0, cacheLeitura: 1_000_000, cacheEscrita: 0 }, 5.5)).toBe(110)
  })

  it('limiar mensal em inteiros', () => {
    expect(limiarAtingido(799, 1000)).toBe(0)
    expect(limiarAtingido(800, 1000)).toBe(80)
    expect(limiarAtingido(1000, 1000)).toBe(100)
    expect(limiarAtingido(5000, null)).toBe(0)
  })

  it('teto efetivo: do número, senão do ambiente, 0 desliga', () => {
    expect(tetoSessaoEfetivo({ teto_sessao_centavos: 250 }, {})).toBe(250)
    expect(tetoSessaoEfetivo({ teto_sessao_centavos: '250' }, {})).toBe(250)
    expect(tetoSessaoEfetivo({ teto_sessao_centavos: 0 }, {})).toBeNull()
    expect(tetoSessaoEfetivo({}, { IA_TETO_SESSAO_CENTAVOS: '90' })).toBe(90)
    expect(tetoSessaoEfetivo({}, { IA_TETO_SESSAO_CENTAVOS: '0' })).toBeNull()
    expect(tetoSessaoEfetivo({}, {})).toBe(300)
  })
})

// ── banco ────────────────────────────────────────────────────────────────────

const A = 'c05f0000-0000-4000-8000-00000000000a'
const B = 'c05f0000-0000-4000-8000-00000000000b'
const PV_A = 'c05f0000-1111-4000-8000-00000000000a'
const PV_B = 'c05f0000-1111-4000-8000-00000000000b'
const PLANO = 'c05f0000-3333-4000-8000-000000000001'
const MODELO = 'c05f0000-4444-4000-8000-000000000001'
const CANAL_A = 'c05f0000-5555-4000-8000-00000000000a'
const CANAL_B = 'c05f0000-5555-4000-8000-00000000000b'
const CONTATO = (t: string) => `c05f0000-6666-4000-8000-${t.slice(-12)}`
const CONVERSA = (t: string) => `c05f0000-7777-4000-8000-${t.slice(-12)}`
const CANAL = (t: string) => (t === A ? CANAL_A : CANAL_B)

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const chamar = (t: string, m: 'GET' | 'PUT', url: string, corpo?: Record<string, unknown>) =>
  app.inject({ method: m, url, headers: { 'x-tenant-id': t }, ...(corpo ? { payload: corpo } : {}) })

const gastar = (t: string, centavos: number, modelo = 'claude-sonnet-5-5', quando = new Date()) => dono`
  INSERT INTO agente_decisao (tenant_id, id, conversa_id, canal_id, modo, desfecho, modelo, custo_centavos, criado_em)
  VALUES (${t}, ${crypto.randomUUID()}, ${CONVERSA(t)}, ${CANAL(t)}, 'autonomo', 'respondeu', ${modelo}, ${centavos}, ${quando})`
const alertas = async (t: string) => (await dono<{ tipo: string; severidade: string; mensagem: string }[]>`
  SELECT tipo, severidade, mensagem FROM alerta WHERE tenant_id = ${t} AND resolvido_em IS NULL ORDER BY tipo`)
const verificar = (t: string, agora = new Date()) => comTenantServico(t, (tx) => verificarOrcamentoMensal(tx, t, agora))

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-custo', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-custo', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[A, PV_A, 'Custo A'], [B, PV_B, 'Custo B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
    await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES (${t}, ${CANAL(t)}, 'whatsapp_nao_oficial', 'Loja', 'conectado') ON CONFLICT DO NOTHING`
    await dono`INSERT INTO contato (tenant_id, id, nome, ativo) VALUES (${t}, ${CONTATO(t)}, 'Cliente', true) ON CONFLICT DO NOTHING`
    await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${t}, ${CONVERSA(t)}, ${CANAL(t)}, ${CONTATO(t)}, 1) ON CONFLICT DO NOTHING`
  }
  app = await criarApp(); await app.ready()
})

beforeEach(async () => {
  limparCacheDeCusto()
  for (const t of ['agente_decisao', 'agente_orcamento', 'alerta', 'notificacao', 'outbox', 'auditoria', 'usuario_filial', 'usuario', 'agente_config']) {
    await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id IN ('${A}', '${B}')`)
  }
})

afterAll(async () => {
  for (const t of ['agente_decisao', 'agente_orcamento', 'alerta', 'notificacao', 'outbox', 'auditoria', 'usuario_filial', 'usuario', 'agente_config', 'conversa', 'contato', 'canal_conectado']) {
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

describe('precoDoModelo pelo catálogo do banco (0093 + 0099)', () => {
  it('lê o catálogo de verdade: Groq gratuito = 0; Claude com preço de cache da 0099', async () => {
    expect((await precoDoModelo({ provedor: 'groq', modelo: 'openai/gpt-oss-120b' })).origem).toBe('gratuito')
    const opus = await precoDoModelo({ provedor: 'claude', modelo: 'us.anthropic.claude-opus-5-5-v1:0' })
    expect(opus).toMatchObject({ origem: 'catalogo', codigo: 'claude-opus-5-5', preco: { entrada: 4, saida: 20, cacheLeitura: 0.2, cacheEscrita: 5 } })
    expect((await catalogoDePrecos()).length).toBeGreaterThanOrEqual(12)
  })

  it('catálogo real: qwen3-coder pago não herda o :free do OpenRouter', async () => {
    expect((await precoDoModelo({ provedor: 'openrouter', modelo: 'qwen/qwen3-coder:free' })).origem).toBe('gratuito')
    expect((await precoDoModelo({ provedor: 'openrouter', modelo: 'qwen/qwen3-coder' })).origem).toBe('desconhecido')
  })

  it('Groq gratuito custa 0 no laço (contrato do turno)', async () => {
    const c = await custoDoLaco({ provedor: 'groq', modelo: 'openai/gpt-oss-120b', uso: { entrada: 900_000, saida: 100_000, cacheLeitura: 0, cacheEscrita: 0 } })
    expect(c).toBe(0)
  })

  it('desconhecido → maior preço + alerta preco_desconhecido no tenant, uma vez', async () => {
    const uso = { entrada: 1_000_000, saida: 0, cacheLeitura: 0, cacheEscrita: 0 }
    const c = await custoDoLaco({ provedor: 'openrouter', modelo: 'acme/modelo-novo-9', uso, tenantId: A })
    const maior = maiorPreco(await catalogoDePrecos())
    expect(c).toBe(Math.round(maior.entrada * 5.5 * 100))
    expect(c).toBeGreaterThan(0)
    await custoDoLaco({ provedor: 'openrouter', modelo: 'acme/modelo-novo-9', uso, tenantId: A })
    const a = await alertas(A)
    expect(a.map((x) => x.tipo)).toEqual(['preco_desconhecido'])
    expect(a[0]!.mensagem).toContain('modelo-novo-9')
    expect(await alertas(B)).toEqual([])
  })

  it('sem tenant no custo, a verificação mensal acha o modelo sem preço do mês e alerta', async () => {
    await gastar(A, 5, 'acme/outro-modelo')
    await verificar(A)
    expect((await alertas(A)).map((x) => x.tipo)).toEqual(['preco_desconhecido'])
  })
})

describe('Orçamento mensal: alerta 80% e 100%, uma vez por mês cada', () => {
  it('sem orçamento não alerta', async () => {
    await gastar(A, 1_000_000)
    expect((await verificar(A)).alertou).toBe(0)
    expect(await alertas(A)).toEqual([])
  })

  it('80% alerta uma vez; 100% alerta uma vez; mês seguinte alerta de novo', async () => {
    await dono`INSERT INTO agente_orcamento (tenant_id, mensal_centavos) VALUES (${A}, 1000)`
    const agora = new Date()
    await gastar(A, 700)
    expect((await verificar(A, agora)).alertou).toBe(0)
    await gastar(A, 150) // 850 → 80%
    expect((await verificar(A, agora)).alertou).toBe(80)
    expect((await verificar(A, agora)).alertou).toBe(0) // não repete
    await gastar(A, 100) // 950 → ainda 80%
    expect((await verificar(A, agora)).alertou).toBe(0)
    await gastar(A, 60) // 1010 → 100%
    expect((await verificar(A, agora)).alertou).toBe(100)
    expect((await verificar(A, agora)).alertou).toBe(0)
    const a = await alertas(A)
    expect(a.map((x) => [x.tipo, x.severidade])).toEqual([['agente_orcamento_100', 'critico'], ['agente_orcamento_80', 'aviso']])
    expect((await dono`SELECT 1 FROM outbox WHERE tenant_id = ${A} AND tipo = 'alerta.novo'`).length).toBeGreaterThanOrEqual(2)

    // Mês seguinte: o gasto do mês zera; com novo gasto, alerta de novo.
    const proximo = new Date(agora.getFullYear(), agora.getMonth() + 1, 15, 12)
    await gastar(A, 900, 'claude-sonnet-5-5', proximo)
    expect((await verificar(A, proximo)).alertou).toBe(80)
  })

  it('salto direto para 100% alerta só 100% e não alerta 80% depois', async () => {
    await dono`INSERT INTO agente_orcamento (tenant_id, mensal_centavos) VALUES (${A}, 1000)`
    await gastar(A, 2000)
    expect((await verificar(A)).alertou).toBe(100)
    expect((await verificar(A)).alertou).toBe(0)
    expect((await alertas(A)).map((x) => x.tipo)).toEqual(['agente_orcamento_100'])
  })

  it('concorrência: duas verificações em paralelo cruzando 80% → UM alerta só', async () => {
    await dono`INSERT INTO agente_orcamento (tenant_id, mensal_centavos) VALUES (${A}, 1000)`
    await gastar(A, 850)
    const rs = await Promise.all([verificar(A), verificar(A), verificar(A)])
    expect(rs.map((r) => r.alertou).sort()).toEqual([0, 0, 80])
    expect((await alertas(A)).map((x) => x.tipo)).toEqual(['agente_orcamento_80'])
  })

  it('notifica os admins (ou, sem admin, os usuários ativos) no sino', async () => {
    await dono`INSERT INTO agente_orcamento (tenant_id, mensal_centavos) VALUES (${A}, 100)`
    const u = crypto.randomUUID()
    await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${A}, ${u}, 'sub-custo-a', 'Ana', 'ana@a.test')`
    await gastar(A, 100)
    await verificar(A)
    const n = await dono<{ usuario_id: string; tipo: string; conversa_id: string | null }[]>`SELECT usuario_id, tipo, conversa_id FROM notificacao WHERE tenant_id = ${A}`
    expect(n).toEqual([{ usuario_id: u, tipo: 'agente.orcamento', conversa_id: null }])
  })
})

describe('RLS — dois tenants', () => {
  it('o gasto e o orçamento de A não aparecem para B, nem pela tabela nem pela rota', async () => {
    await dono`INSERT INTO agente_orcamento (tenant_id, mensal_centavos) VALUES (${A}, 1000)`
    await gastar(A, 900)
    // B não vê a linha de A mesmo pedindo pelo id.
    const vistas = await comTenantServico(B, (tx) => tx`SELECT tenant_id FROM agente_orcamento WHERE tenant_id = ${A}`)
    expect(vistas).toEqual([])
    // B com o próprio orçamento: o gasto de A não conta.
    await dono`INSERT INTO agente_orcamento (tenant_id, mensal_centavos) VALUES (${B}, 1000)`
    expect((await verificar(B)).alertou).toBe(0)
    expect(await alertas(B)).toEqual([])

    const ra = await chamar(A, 'GET', '/v1/agente/orcamento')
    expect(ra.json()).toMatchObject({ mensalCentavos: 1000, gastoMesCentavos: 900, limiarAtingido: 80 })
    const rb = await chamar(B, 'GET', '/v1/agente/orcamento')
    expect(rb.json()).toMatchObject({ mensalCentavos: 1000, gastoMesCentavos: 0, limiarAtingido: 0 })
  })

  it('B não lê nem grava o teto do número de A (404)', async () => {
    expect((await chamar(B, 'GET', `/v1/canais/${CANAL_A}/agente/custo`)).statusCode).toBe(404)
    expect((await chamar(B, 'PUT', `/v1/canais/${CANAL_A}/agente/custo`, { tetoSessaoCentavos: 10 })).statusCode).toBe(404)
    expect((await dono`SELECT 1 FROM agente_config WHERE tenant_id = ${A}`).length).toBe(0)
  })
})

describe('Rotas de custo', () => {
  it('PUT orçamento grava, audita e devolve; corpo inválido = 422', async () => {
    expect((await chamar(A, 'PUT', '/v1/agente/orcamento', { mensalCentavos: 1.5 })).statusCode).toBe(422)
    expect((await chamar(A, 'PUT', '/v1/agente/orcamento', { mensalCentavos: 50000, extra: 1 })).statusCode).toBe(422)
    const r = await chamar(A, 'PUT', '/v1/agente/orcamento', { mensalCentavos: 50000 })
    expect(r.statusCode).toBe(200)
    expect((await chamar(A, 'GET', '/v1/agente/orcamento')).json().mensalCentavos).toBe(50000)
    const [aud] = await dono<{ dados: { antes: number | null; depois: number } }[]>`
      SELECT dados FROM auditoria WHERE tenant_id = ${A} AND acao = 'agente.orcamento_alterado'`
    expect(aud!.dados).toEqual({ antes: null, depois: 50000 })
    expect((await chamar(A, 'PUT', '/v1/agente/orcamento', { mensalCentavos: null })).statusCode).toBe(200)
    expect((await chamar(A, 'GET', '/v1/agente/orcamento')).json().mensalCentavos).toBeNull()
  })

  it('PUT teto por sessão em número sem configuração cria a linha desligada; GET mostra efetivo', async () => {
    const r = await chamar(A, 'PUT', `/v1/canais/${CANAL_A}/agente/custo`, { tetoSessaoCentavos: 120 })
    expect(r.statusCode).toBe(200)
    const [cfg] = await dono<{ modo: string; teto: string }[]>`SELECT modo, teto_sessao_centavos::text AS teto FROM agente_config WHERE tenant_id = ${A}`
    expect(cfg).toEqual({ modo: 'desligado', teto: '120' })
    const g = (await chamar(A, 'GET', `/v1/canais/${CANAL_A}/agente/custo`)).json()
    expect(g).toMatchObject({ tetoSessaoCentavos: 120, tetoSessaoEfetivoCentavos: 120 })
    await chamar(A, 'PUT', `/v1/canais/${CANAL_A}/agente/custo`, { tetoSessaoCentavos: 0 })
    expect((await chamar(A, 'GET', `/v1/canais/${CANAL_A}/agente/custo`)).json().tetoSessaoEfetivoCentavos).toBeNull()
  })

  it('quem não é admin (com admin no tenant) recebe 403', async () => {
    const admin = crypto.randomUUID()
    await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${B}, ${admin}, 'sub-admin-b', 'Bia', 'bia@b.test')`
    await dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES (${B}, ${admin}, NULL, 'admin')`
    const r = await chamar(B, 'PUT', '/v1/agente/orcamento', { mensalCentavos: 100 })
    expect(r.statusCode).toBe(403)
    expect(r.json().erro).toBe('acesso.papel_insuficiente')
    expect((await chamar(B, 'GET', '/v1/agente/orcamento')).statusCode).toBe(200)
  })
})
