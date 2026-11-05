import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import type { FastifyInstance } from 'fastify'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'

/**
 * Rotas da raia G3 por `fastify.inject()`: automação de pós-venda (validação do
 * gatilho/ação), painel de NPS com o bloco do agente e a PROVA SOCIAL no
 * Conhecimento (campos, aprovação por admin, vetos, edição que revoga, filtro).
 * UUIDs e códigos exclusivos deste arquivo.
 */
const T = 'c3c00000-0000-4000-8000-000000000001'
const OUTRO = 'c3c00000-0000-4000-8000-000000000002'
const PV = 'c3c00000-1111-4000-8000-000000000001'
const PV2 = 'c3c00000-1111-4000-8000-000000000002'
const PLANO = 'c3c00000-3333-4000-8000-000000000001'
const MODELO = 'c3c00000-4444-4000-8000-000000000001'
const TPL = 'c3c00000-8888-4000-8000-000000000001'
const ADMIN_OUTRO = 'c3c00000-9999-4000-8000-000000000001'
const CONTATO = 'c3c00000-6666-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const chamar = (t: string, m: 'GET' | 'POST' | 'PATCH', url: string, corpo?: Record<string, unknown>) =>
  app.inject({ method: m, url, headers: { 'x-tenant-id': t }, ...(corpo ? { payload: corpo } : {}) })
const hoje = new Date().toISOString().slice(0, 10)
/** Aprova a versão que está no banco agora (a "vista" pelo admin — M2). */
const aprovarVista = async (t: string, id: string) => {
  const [d] = await dono<{ versao: number }[]>`SELECT versao FROM conhecimento_documento WHERE id = ${id}`
  return chamar(t, 'POST', `/v1/agente/conhecimento/${id}/aprovar`, { aprovado: true, versao: d?.versao ?? 1 })
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-g3-rotas', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-g3-rotas', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'G3 Rotas'], [OUTRO, PV2, 'G3 Rotas 2']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await dono`INSERT INTO template (tenant_id, id, nome, categoria, idioma) VALUES (${T}, ${TPL}, 'pos_venda_rotas', 'MARKETING', 'pt_BR') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato (tenant_id, id, nome, ativo) VALUES (${T}, ${CONTATO}, 'Cliente NPS', true) ON CONFLICT DO NOTHING`
  app = await criarApp(); await app.ready()
})
afterAll(async () => {
  for (const t of [T, OUTRO]) {
    for (const tab of ['automacao', 'nps_resposta', 'conhecimento_documento', 'auditoria', 'template', 'contato', 'usuario_filial', 'usuario']) {
      await dono.unsafe(`DELETE FROM ${tab} WHERE tenant_id = '${t}'`)
    }
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('POST /v1/automacoes — pós-venda', () => {
  const base = { nome: 'Pós-venda D+3', gatilho: 'pedido_efetivado', acao: 'agente_envia' }

  it('cria com diasDepois e roteiro; o parâmetro é gravado normalizado', async () => {
    const r = await chamar(T, 'POST', '/v1/automacoes', { ...base, gatilhoParam: { diasDepois: 3 }, acaoParam: { roteiro: 'nps', texto: ' De 0 a 10? ', templateId: TPL } })
    expect(r.statusCode).toBe(201)
    const [a] = await dono<{ gatilho_param: unknown; acao_param: unknown }[]>`SELECT gatilho_param, acao_param FROM automacao WHERE id = ${(r.json() as { id: string }).id}`
    expect(a).toEqual({ gatilho_param: { diasDepois: 3 }, acao_param: { roteiro: 'nps', texto: 'De 0 a 10?', templateId: TPL } })
  })

  it.each([
    [{ diasDepois: 61 }, { roteiro: 'nps', texto: 'x' }, 'automacao.gatilho_param_invalido', 'gatilhoParam.diasDepois'],
    [{ diasDepois: -1 }, { roteiro: 'nps', texto: 'x' }, 'automacao.gatilho_param_invalido', 'gatilhoParam.diasDepois'],
    [{ diasDepois: 0 }, { roteiro: 'cupom', texto: 'x' }, 'automacao.acao_param_invalido', 'acaoParam.roteiro'],
    [{ diasDepois: 0 }, { roteiro: 'agradecimento' }, 'automacao.acao_param_invalido', 'acaoParam.texto'],
    [{ diasDepois: 0 }, { roteiro: 'agradecimento', texto: 'x'.repeat(901) }, 'automacao.acao_param_invalido', 'acaoParam.texto'],
  ])('parâmetro inválido %j / %j → 422 %s no campo', async (g, a, erro, campo) => {
    const r = await chamar(T, 'POST', '/v1/automacoes', { ...base, gatilhoParam: g, acaoParam: a })
    expect(r.statusCode).toBe(422)
    expect(r.json()).toMatchObject({ erro, campos: [campo] })
  })

  it('o gatilho e a ação andam juntos (422 automacao.pos_venda_combinacao)', async () => {
    const r1 = await chamar(T, 'POST', '/v1/automacoes', { nome: 'x', gatilho: 'pedido_efetivado', acao: 'criar_tarefa', acaoParam: { titulo: 'x' } })
    const r2 = await chamar(T, 'POST', '/v1/automacoes', { nome: 'x', gatilho: 'lead_frio', acao: 'agente_envia', acaoParam: { roteiro: 'nps', texto: 'x' } })
    expect([r1.statusCode, r2.statusCode]).toEqual([422, 422])
    expect(r1.json()).toMatchObject({ erro: 'automacao.pos_venda_combinacao' })
  })

  it('template de OUTRO tenant não serve (422 automacao.template_invalida)', async () => {
    const r = await chamar(OUTRO, 'POST', '/v1/automacoes', { ...base, gatilhoParam: { diasDepois: 0 }, acaoParam: { roteiro: 'nps', templateId: TPL } })
    expect(r.statusCode).toBe(422)
    expect(r.json()).toMatchObject({ erro: 'automacao.template_invalida' })
  })
})

describe('GET /v1/nps — bloco do agente', () => {
  it('a nota do agente aparece separada (agente.total/score) e fora de "sem atendente"', async () => {
    await dono`INSERT INTO nps_resposta (tenant_id, id, contato_id, nota, origem) VALUES
      (${T}, gen_random_uuid(), ${CONTATO}, 10, 'agente'), (${T}, gen_random_uuid(), ${CONTATO}, 3, 'agente'),
      (${T}, gen_random_uuid(), ${CONTATO}, 9, 'manual')`
    const r = await chamar(T, 'GET', '/v1/nps?dias=30')
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({
      geral: { total: 3, semAtendente: 1 },
      agente: { total: 2, promotores: 1, neutros: 0, detratores: 1, score: 0 },
    })
    const b = await chamar(OUTRO, 'GET', '/v1/nps?dias=30')
    expect(b.json()).toMatchObject({ geral: { total: 0 }, agente: { total: 0, score: null } })
  })
})

describe('Prova social no Conhecimento', () => {
  type Doc = { id: string; tipo: string; fonte: string | null; link: string | null; apuradoEm: string | null; provaTipo: string | null; consentimento: boolean; aprovado: boolean }
  const criar = (extra: Record<string, unknown> = {}) => chamar(T, 'POST', '/v1/agente/conhecimento', {
    titulo: 'NPS 2026', tipo: 'prova_social', conteudo: '98% dos clientes nos recomendam.',
    fonte: 'Pesquisa NPS 2026', link: 'https://exemplo.test/nps', apuradoEm: hoje, provaTipo: 'numero', ...extra,
  })

  it('cria com os campos novos e NASCE não aprovada', async () => {
    const r = await criar()
    expect(r.statusCode).toBe(201)
    expect(r.json()).toMatchObject({ tipo: 'prova_social', fonte: 'Pesquisa NPS 2026', link: 'https://exemplo.test/nps', apuradoEm: hoje, provaTipo: 'numero', aprovado: false })
  })

  it('link que não é http(s) → 422 no campo link', async () => {
    const r = await criar({ link: 'javascript:alert(1)' })
    expect(r.statusCode).toBe(422)
    expect(r.json()).toMatchObject({ campos: ['link'] })
  })

  it('aprovar exige fonte, data e tipo; depoimento exige consentimento (422 por campo)', async () => {
    const sem = (await criar({ fonte: null, apuradoEm: null })).json() as Doc
    const r = await aprovarVista(T, sem.id)
    expect(r.statusCode).toBe(422)
    expect(r.json()).toMatchObject({ erro: 'conhecimento.prova_social_incompleta' })
    expect((r.json() as { campos: string[] }).campos).toEqual(expect.arrayContaining(['fonte', 'apuradoEm']))

    const dep = (await criar({ provaTipo: 'depoimento', conteudo: 'Atendimento excelente, recomendo.' })).json() as Doc
    const r2 = await aprovarVista(T, dep.id)
    expect(r2.json()).toMatchObject({ campos: ['consentimento'] })
    await chamar(T, 'PATCH', `/v1/agente/conhecimento/${dep.id}`, { consentimento: true })
    const r3 = await aprovarVista(T, dep.id)
    expect(r3.statusCode).toBe(200)
    expect(r3.json()).toMatchObject({ aprovado: true })
  })

  it('⚠️ texto vetado ("sem reclamações", promessa de prazo) não é aprovado', async () => {
    const d = (await criar({ conteudo: 'Somos a loja sem nenhuma reclamação no Reclame Aqui.' })).json() as Doc
    const r = await aprovarVista(T, d.id)
    expect(r.statusCode).toBe(422)
    expect(r.json()).toMatchObject({ campos: ['conteudo'] })
  })

  it('⚠️ editar texto ou fonte de uma APROVADA volta para pendente; publicar/despublicar não', async () => {
    const d = (await criar()).json() as Doc
    expect((await aprovarVista(T, d.id)).json()).toMatchObject({ aprovado: true })
    expect((await chamar(T, 'PATCH', `/v1/agente/conhecimento/${d.id}`, { publicado: true })).json()).toMatchObject({ aprovado: true })
    expect((await chamar(T, 'PATCH', `/v1/agente/conhecimento/${d.id}`, { fonte: 'Outra pesquisa' })).json()).toMatchObject({ aprovado: false })
    await aprovarVista(T, d.id)
    expect((await chamar(T, 'PATCH', `/v1/agente/conhecimento/${d.id}`, { conteudo: '97% dos clientes nos recomendam.' })).json()).toMatchObject({ aprovado: false })
    const aud = await dono<{ acao: string }[]>`SELECT acao FROM auditoria WHERE tenant_id = ${T} AND entidade_id = ${d.id} AND acao LIKE 'conhecimento.prova_social%'`
    expect(aud.map((a) => a.acao)).toEqual(['conhecimento.prova_social_aprovada', 'conhecimento.prova_social_aprovada'])
  })

  it('⚠️ M2: aprovar amarra a versão vista — documento mudou depois → 409; sem versão → 422', async () => {
    const d = (await criar()).json() as Doc & { versao: number }
    const semVersao = await chamar(T, 'POST', `/v1/agente/conhecimento/${d.id}/aprovar`, { aprovado: true })
    expect(semVersao.statusCode).toBe(422)
    const vista = d.versao
    // O consentimento/fonte muda depois de o admin abrir: a versão sobe.
    const editado = (await chamar(T, 'PATCH', `/v1/agente/conhecimento/${d.id}`, { fonte: 'Outra fonte' })).json() as { versao: number }
    expect(editado.versao).toBe(vista + 1)
    const r = await chamar(T, 'POST', `/v1/agente/conhecimento/${d.id}/aprovar`, { aprovado: true, versao: vista })
    expect(r.statusCode).toBe(409)
    expect(r.json()).toMatchObject({ erro: 'conhecimento.versao_divergente', versaoAtual: vista + 1 })
  })

  it('⚠️ M2/B2: mudar consentimento ou o número (canal) de uma aprovada sobe a versão e revoga', async () => {
    const dep = (await criar({ provaTipo: 'depoimento', conteudo: 'Atendimento excelente.', consentimento: true })).json() as Doc & { versao: number }
    expect((await aprovarVista(T, dep.id)).json()).toMatchObject({ aprovado: true })
    const semConsent = (await chamar(T, 'PATCH', `/v1/agente/conhecimento/${dep.id}`, { consentimento: false })).json() as Doc & { versao: number }
    expect(semConsent).toMatchObject({ aprovado: false, versao: dep.versao + 1 })
    await chamar(T, 'PATCH', `/v1/agente/conhecimento/${dep.id}`, { consentimento: true })
    expect((await aprovarVista(T, dep.id)).json()).toMatchObject({ aprovado: true })
    const [canal] = await dono<{ id: string }[]>`
      INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES (${T}, gen_random_uuid(), 'whatsapp_nao_oficial', 'B2', 'conectado') RETURNING id`
    const movido = (await chamar(T, 'PATCH', `/v1/agente/conhecimento/${dep.id}`, { canalId: canal!.id })).json() as Doc
    expect(movido).toMatchObject({ aprovado: false })
    await dono`DELETE FROM conhecimento_documento WHERE canal_id = ${canal!.id}`
    await dono`DELETE FROM canal_conectado WHERE id = ${canal!.id}`
  })

  it('revogar a aprovação (aprovado: false)', async () => {
    const d = (await criar()).json() as Doc
    await aprovarVista(T, d.id)
    const r = await chamar(T, 'POST', `/v1/agente/conhecimento/${d.id}/aprovar`, { aprovado: false })
    expect(r.json()).toMatchObject({ aprovado: false })
  })

  it('documento que não é prova social não é aprovado (422)', async () => {
    const d = (await chamar(T, 'POST', '/v1/agente/conhecimento', { titulo: 'FAQ', tipo: 'faq', conteudo: 'Trocas em 7 dias.' })).json() as Doc
    expect(d).toMatchObject({ fonte: null, aprovado: false })
    const r = await aprovarVista(T, d.id)
    expect(r.json()).toMatchObject({ erro: 'conhecimento.nao_e_prova_social' })
  })

  it('filtro ?tipo=prova_social lista só prova social; tipo inválido → 422', async () => {
    const r = await chamar(T, 'GET', '/v1/agente/conhecimento?tipo=prova_social')
    const itens = (r.json() as { itens: Doc[] }).itens
    expect(itens.length).toBeGreaterThan(0)
    expect(itens.every((i) => i.tipo === 'prova_social')).toBe(true)
    expect((await chamar(T, 'GET', '/v1/agente/conhecimento?tipo=segredo')).statusCode).toBe(422)
  })

  it('dois tenants: aprovar documento de outro tenant → 404', async () => {
    const d = (await criar()).json() as Doc
    expect((await aprovarVista(OUTRO, d.id)).statusCode).toBe(404)
  })

  it('⚠️ só ADMIN aprova: com um admin no tenant, quem é vendedor recebe 403', async () => {
    const d = (await criar()).json() as Doc
    await chamar(T, 'GET', '/v1/agente/conhecimento') // garante o usuário do dev
    const [eu] = await dono<{ id: string }[]>`SELECT id FROM usuario WHERE tenant_id = ${T} AND cognito_sub = ${`dev-${T}`}`
    if (!eu) {
      // O GET não cria usuário: a rota de aprovar cria antes de checar o papel.
      await chamar(T, 'POST', `/v1/agente/conhecimento/${d.id}/aprovar`, { aprovado: false })
    }
    const [eu2] = await dono<{ id: string }[]>`SELECT id FROM usuario WHERE tenant_id = ${T} AND cognito_sub = ${`dev-${T}`}`
    await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${T}, ${ADMIN_OUTRO}, 'sub-admin-g3', 'Ada', 'ada@g3.test') ON CONFLICT DO NOTHING`
    await dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES (${T}, ${ADMIN_OUTRO}, NULL, 'admin'), (${T}, ${eu2!.id}, NULL, 'vendedor')
               ON CONFLICT DO NOTHING`
    const r = await aprovarVista(T, d.id)
    expect(r.statusCode).toBe(403)
    expect(r.json()).toMatchObject({ erro: 'acesso.papel_insuficiente' })
  })
})
