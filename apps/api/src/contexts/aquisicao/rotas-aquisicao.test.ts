import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import type { FastifyInstance } from 'fastify'
import { criarApp } from '../../app.js'
import { extrairCodigoOrigem } from '@geracrm/shared'

const T = 'a0f11a00-0000-4000-8000-000000000001'
const T2 = 'a0f11a00-0000-4000-8000-000000000002'
const PV = 'a0f11a00-1111-4000-8000-000000000001'
const PV2 = 'a0f11a00-1111-4000-8000-000000000002'
const PLANO = 'a0f11a00-3333-4000-8000-000000000001'
const MODELO = 'a0f11a00-4444-4000-8000-000000000001'
const CONTATO = 'a0f11a00-6666-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance

const chamar = (t: string, m: 'GET' | 'POST', url: string, corpo?: Record<string, unknown>) =>
  app.inject({ method: m, url, headers: { 'x-tenant-id': t }, ...(corpo ? { payload: corpo } : {}) })

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-teste-rotas-aq', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-teste-rotas-aq', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv] of [[T, PV], [T2, PV2]] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id)
               VALUES (${t}, 'Loja', ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome)
               VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await dono`INSERT INTO contato (tenant_id, id, nome) VALUES (${T}, ${CONTATO}, 'Lead') ON CONFLICT DO NOTHING`
  app = await criarApp(); await app.ready()
})

afterAll(async () => {
  await app.close()
  for (const t of [T, T2]) {
    await dono`DELETE FROM midia_sessao_lp WHERE tenant_id = ${t}`
    await dono`DELETE FROM midia_conta     WHERE tenant_id = ${t}`
    await dono`DELETE FROM contato         WHERE tenant_id = ${t}`
  }
  await dono.end()
})

describe('Contas de anúncio', () => {
  it('cadastra, lista e recusa duplicata como CONFLITO, não erro de servidor', async () => {
    const criada = await chamar(T, 'POST', '/v1/aquisicao/contas', {
      plataforma: 'google', idExterno: '123-456-7890', nome: 'Conta da Loja',
    })
    expect(criada.statusCode).toBe(201)

    const lista = await chamar(T, 'GET', '/v1/aquisicao/contas').then((r) => r.json())
    expect(lista.contas).toHaveLength(1)
    expect(lista.contas[0]).toMatchObject({ plataforma: 'google', moeda: 'BRL' })

    // ⚠️ Falha de negócio é retorno tipificado (PED-08), não 500.
    const repetida = await chamar(T, 'POST', '/v1/aquisicao/contas', {
      plataforma: 'google', idExterno: '123-456-7890', nome: 'De novo',
    })
    expect(repetida.statusCode).toBe(409)
    expect(repetida.json().erro).toBe('conta.ja_cadastrada')
  })

  it('recusa plataforma fora da lista', async () => {
    const r = await chamar(T, 'POST', '/v1/aquisicao/contas', {
      plataforma: 'linkedin', idExterno: 'x', nome: 'X',
    })
    expect(r.statusCode).toBe(422)
    expect(r.json().erro).toBe('plataforma.invalida')
  })

  // ⚠️ ADR-001: o tenant sai do token, e o outro não enxerga.
  it('a conta de um tenant não aparece no outro', async () => {
    const lista = await chamar(T2, 'GET', '/v1/aquisicao/contas').then((r) => r.json())
    expect(lista.contas).toHaveLength(0)
  })
})

describe('Sessão da landing page', () => {
  it('devolve código, texto pronto e o link wa.me', async () => {
    const r = await chamar(T, 'POST', '/v1/aquisicao/sessoes', {
      telefone: '+55 81 99861-7049',
      textoBase: 'Olá! Vi o anúncio da coleção',
      clickId: 'gclid-abc',
      utmSource: 'google',
    }).then((r) => r.json())

    expect(r.codigo).toMatch(/^[A-Z0-9]{6}$/)
    expect(r.link).toContain('https://wa.me/5581998617049?text=')
    // ⚠️ O ciclo se fecha: o que a rota monta, o extrator lê de volta.
    expect(extrairCodigoOrigem(r.textoPronto)).toBe(r.codigo)
  })

  it('a sessão guarda o clique e o utm para a atribuição', async () => {
    const { codigo } = await chamar(T, 'POST', '/v1/aquisicao/sessoes', {
      telefone: '5581999999999', clickId: 'gclid-xyz', utmSource: 'google', utmCampaign: 'verao',
    }).then((r) => r.json())

    const [s] = await dono<{ click_id: string; utm_campaign: string }[]>`
      SELECT click_id, utm_campaign FROM midia_sessao_lp WHERE tenant_id = ${T} AND codigo = ${codigo}`
    expect(s).toMatchObject({ click_id: 'gclid-xyz', utm_campaign: 'verao' })
  })

  it('recusa telefone ausente ou impossível', async () => {
    expect((await chamar(T, 'POST', '/v1/aquisicao/sessoes', {})).statusCode).toBe(422)
    expect((await chamar(T, 'POST', '/v1/aquisicao/sessoes', { telefone: '123' })).statusCode).toBe(422)
  })

  it('dois códigos seguidos são diferentes', async () => {
    const a = await chamar(T, 'POST', '/v1/aquisicao/sessoes', { telefone: '5581999999999' }).then((r) => r.json())
    const b = await chamar(T, 'POST', '/v1/aquisicao/sessoes', { telefone: '5581999999999' }).then((r) => r.json())
    expect(a.codigo).not.toBe(b.codigo)
  })
})

describe('Diagnóstico do código — testar sem mandar mensagem', () => {
  it('acha a sessão a partir de uma mensagem colada', async () => {
    const s = await chamar(T, 'POST', '/v1/aquisicao/sessoes', {
      telefone: '5581999999999', clickId: 'gclid-diag',
    }).then((r) => r.json())

    const d = await chamar(T, 'POST', '/v1/aquisicao/diagnostico/codigo', {
      mensagem: `oi, tudo bem? ${s.textoPronto}`,
    }).then((r) => r.json())

    expect(d).toMatchObject({ encontrado: true, codigo: s.codigo })
    expect(d.sessao.click_id).toBe('gclid-diag')
  })

  // ⚠️ O caminho ESPERADO quando o lead apaga o texto pronto.
  it('mensagem sem código devolve não-encontrado, não erro', async () => {
    const d = await chamar(T, 'POST', '/v1/aquisicao/diagnostico/codigo', {
      mensagem: 'Oi, quero saber o preço',
    }).then((r) => r.json())
    expect(d).toEqual({ encontrado: false, motivo: 'sem_codigo_ou_ambiguo' })
  })

  it('código de outro tenant não resolve aqui', async () => {
    const s = await chamar(T, 'POST', '/v1/aquisicao/sessoes', { telefone: '5581999999999' }).then((r) => r.json())
    const d = await chamar(T2, 'POST', '/v1/aquisicao/diagnostico/codigo', {
      mensagem: s.textoPronto,
    }).then((r) => r.json())
    expect(d.encontrado).toBe(true)   // o formato é válido…
    expect(d.sessao).toBeNull()       // …mas a sessão é invisível para o outro tenant
  })
})

describe('ROI — o modelo é obrigatório', () => {
  // ⚠️ AMK-009: número de atribuição sem o modelo ao lado é promessa que o
  //    produto não sustenta. A rota recusa em vez de escolher por conta própria.
  it('sem modelo, recusa em vez de assumir um', async () => {
    const r = await chamar(T, 'GET',
      `/v1/aquisicao/anuncios/${CONTATO}/roi?de=2026-08-01&ate=2026-08-10`)
    expect(r.statusCode).toBe(422)
    expect(r.json().erro).toBe('modelo.obrigatorio')
  })

  it('recusa período e janela inválidos', async () => {
    const base = `/v1/aquisicao/anuncios/${CONTATO}/roi`
    expect((await chamar(T, 'GET', `${base}?de=ontem&ate=hoje&modelo=ultimo_toque`)).statusCode).toBe(422)
    expect((await chamar(T, 'GET', `${base}?de=2026-08-01&ate=2026-08-10&janelaDias=900&modelo=ultimo_toque`)).statusCode).toBe(422)
  })

  /**
   * ⚠️ Anúncio que não existe (ou é de outro tenant) responde 404 — nunca um ROI
   * de zeros. "Gastou R$ 0,00 e vendeu R$ 0,00" é uma AFIRMAÇÃO, e sobre um
   * anúncio inexistente ela é falsa; quem abriu um link velho merece saber.
   */
  it('anúncio inexistente é 404, não um ROI de zeros', async () => {
    const r = await chamar(T, 'GET',
      `/v1/aquisicao/anuncios/${CONTATO}/roi?de=2026-08-01&ate=2026-08-10&modelo=ultimo_toque`)
    expect(r.statusCode).toBe(404)
    expect(r.json().erro).toBe('anuncio.nao_encontrado')
  })
})

describe('Painel de anúncios', () => {
  it('lista vazia é resposta válida, com cursor nulo', async () => {
    const r = await chamar(T, 'GET', '/v1/aquisicao/anuncios?de=2026-08-01&ate=2026-08-31').then((r) => r.json())
    expect(r).toMatchObject({ itens: [], temMais: false, cursor: null })
  })

  it('exige período', async () => {
    expect((await chamar(T, 'GET', '/v1/aquisicao/anuncios')).statusCode).toBe(422)
  })
})
