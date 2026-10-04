import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import type { FastifyInstance } from 'fastify'
import { criarApp } from '../../../../app.js'
import { encerrarBanco } from '../../../../db/index.js'

/**
 * As rotas da base de conhecimento: CRUD com versão, cursor, erros 422
 * nomeados, "testar a base", o espelho com `agente_config.politicas` e o
 * isolamento entre tenants — tudo por `fastify.inject()`.
 *
 * ⚠️ UUIDs e códigos de semente exclusivos deste arquivo.
 */
const T = 'c0b30000-0000-4000-8000-000000000001'
const OUTRO = 'c0b30000-0000-4000-8000-000000000002'
const PV = 'c0b30000-1111-4000-8000-000000000001'
const PV2 = 'c0b30000-1111-4000-8000-000000000002'
const PLANO = 'c0b30000-3333-4000-8000-000000000001'
const MODELO = 'c0b30000-4444-4000-8000-000000000001'
const CANAL = 'c0b30000-7777-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const chamar = (t: string, m: 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE', url: string, corpo?: Record<string, unknown>) =>
  app.inject({ method: m, url, headers: { 'x-tenant-id': t }, ...(corpo ? { payload: corpo } : {}) })

type Doc = { id: string; versao: number; trechos: number; titulo: string; tipo: string; publicado: boolean; canalId: string | null; conteudo: string }

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-conhecimento-rotas', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-conhecimento-rotas', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'A'], [OUTRO, PV2, 'B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado)
             VALUES (${T}, ${CANAL}, 'whatsapp_nao_oficial', 'Loja', 'conectado') ON CONFLICT DO NOTHING`
  await dono`DELETE FROM conhecimento_documento WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM agente_config WHERE tenant_id = ${T}`
  app = await criarApp(); await app.ready()
})
afterAll(async () => {
  await dono`DELETE FROM conhecimento_documento WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM agente_config WHERE tenant_id = ${T}`
  await dono`DELETE FROM canal_conectado WHERE tenant_id = ${T}`
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM tenant WHERE id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('CRUD de documentos', () => {
  let faq: Doc

  it('POST cria publicado em v1, já indexado', async () => {
    const r = await chamar(T, 'POST', '/v1/agente/conhecimento', {
      titulo: 'FAQ de frete', tipo: 'frete', conteudo: 'Frete grátis acima de R$ 300 para o Nordeste.\n\nDemais regiões: tabela dos Correios.',
    })
    expect(r.statusCode).toBe(201)
    faq = r.json() as Doc
    expect(faq).toMatchObject({ titulo: 'FAQ de frete', tipo: 'frete', versao: 1, publicado: true, canalId: null })
    expect(faq.trechos).toBeGreaterThanOrEqual(1)
  })

  it('POST com tipo fora da lista → 422 conhecimento.campo_invalido apontando o campo', async () => {
    const r = await chamar(T, 'POST', '/v1/agente/conhecimento', { titulo: 'x', tipo: 'segredo', conteudo: 'y' })
    expect(r.statusCode).toBe(422)
    expect(r.json()).toMatchObject({ erro: 'conhecimento.campo_invalido', campos: ['tipo'] })
  })

  it('POST sem conteúdo → 422 apontando conteudo', async () => {
    const r = await chamar(T, 'POST', '/v1/agente/conhecimento', { titulo: 'x', tipo: 'faq', conteudo: '   ' })
    expect(r.statusCode).toBe(422)
    expect((r.json() as { campos: string[] }).campos).toEqual(['conteudo'])
  })

  it('POST de políticas POR CANAL é recusado: isso se escreve na configuração do agente', async () => {
    const r = await chamar(T, 'POST', '/v1/agente/conhecimento', { titulo: 'Pol', tipo: 'politicas', conteudo: 'x', canalId: CANAL })
    expect(r.statusCode).toBe(422)
    expect((r.json() as { erro: string }).erro).toBe('conhecimento.politicas_pelo_canal')
  })

  it('POST com canal que não é deste tenant → 422 conhecimento.canal_invalido', async () => {
    const r = await chamar(T, 'POST', '/v1/agente/conhecimento', { titulo: 'x', tipo: 'faq', conteudo: 'y', canalId: 'c0b30000-7777-4000-8000-0000000000ff' })
    expect(r.statusCode).toBe(422)
    expect((r.json() as { erro: string }).erro).toBe('conhecimento.canal_invalido')
  })

  it('PATCH de conteúdo sobe a versão e reindexa; PATCH só de publicado não sobe', async () => {
    const r = await chamar(T, 'PATCH', `/v1/agente/conhecimento/${faq.id}`, { conteudo: 'Frete grátis acima de R$ 250.' })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ versao: 2, conteudo: 'Frete grátis acima de R$ 250.', trechos: 1 })

    const r2 = await chamar(T, 'PATCH', `/v1/agente/conhecimento/${faq.id}`, { publicado: false })
    expect(r2.json()).toMatchObject({ versao: 2, publicado: false })
    const r3 = await chamar(T, 'PATCH', `/v1/agente/conhecimento/${faq.id}`, { publicado: true, titulo: 'FAQ de frete e prazos' })
    expect(r3.json()).toMatchObject({ versao: 3, publicado: true, titulo: 'FAQ de frete e prazos' })
  })

  it('PATCH com campo inválido → 422; id desconhecido → 404', async () => {
    expect((await chamar(T, 'PATCH', `/v1/agente/conhecimento/${faq.id}`, { tipo: 'nada' })).statusCode).toBe(422)
    expect((await chamar(T, 'PATCH', '/v1/agente/conhecimento/c0b30000-9999-4000-8000-000000000001', { titulo: 'x' })).statusCode).toBe(404)
    expect((await chamar(T, 'PATCH', '/v1/agente/conhecimento/nao-e-uuid', { titulo: 'x' })).statusCode).toBe(404)
  })

  it('DELETE despublica (some da lista, volta com incluirDespublicados) e repetir dá 200 ainda', async () => {
    const r = await chamar(T, 'DELETE', `/v1/agente/conhecimento/${faq.id}`)
    expect(r.statusCode).toBe(200)
    const lista = (await chamar(T, 'GET', '/v1/agente/conhecimento')).json() as { itens: Doc[] }
    expect(lista.itens.map((d) => d.id)).not.toContain(faq.id)
    const tudo = (await chamar(T, 'GET', '/v1/agente/conhecimento?incluirDespublicados=true')).json() as { itens: Doc[] }
    expect(tudo.itens.find((d) => d.id === faq.id)).toMatchObject({ publicado: false, versao: 3 })
    expect((await chamar(T, 'DELETE', '/v1/agente/conhecimento/c0b30000-9999-4000-8000-000000000001')).statusCode).toBe(404)
  })
})

describe('Capacidades, embutir e extrair', () => {
  it('GET capacidades diz se há pgvector e que falta VOYAGE_API_KEY (ambiente de teste sem chave)', async () => {
    const r = await chamar(T, 'GET', '/v1/agente/conhecimento/capacidades')
    expect(r.statusCode).toBe(200)
    const cap = r.json() as { pgvector: boolean; semantica: string; embedding: { configurado: boolean; falta: string | null }; pendentes: { trechos: number; produtos: number } }
    expect(typeof cap.pgvector).toBe('boolean')
    expect(cap.embedding).toMatchObject({ configurado: false, falta: 'VOYAGE_API_KEY' })
    expect(cap.semantica).toBe(cap.pgvector ? 'sem_chave' : 'sem_pgvector')
    expect(cap.pendentes.trechos).toBeGreaterThanOrEqual(0)
  })

  it('POST embutir sem chave → 409 conhecimento.semantica_desligada com o motivo', async () => {
    const r = await chamar(T, 'POST', '/v1/agente/conhecimento/embutir')
    expect(r.statusCode).toBe(409)
    expect(r.json()).toMatchObject({ erro: 'conhecimento.semantica_desligada' })
    expect(['sem_chave', 'sem_pgvector']).toContain((r.json() as { semantica: string }).semantica)
  })

  it('POST extrair .md devolve o texto para revisão, sem criar documento; data-URL é aceita', async () => {
    const antes = (await chamar(T, 'GET', '/v1/agente/conhecimento?incluirDespublicados=true')).json() as { itens: Doc[] }
    const b64 = Buffer.from('# Frete\r\n\r\nEnviamos em 2 dias.\r\n', 'utf8').toString('base64')
    const r = await chamar(T, 'POST', '/v1/agente/conhecimento/extrair', { nome: 'frete.md', tipo: 'text/markdown', conteudoBase64: `data:text/markdown;base64,${b64}` })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ texto: '# Frete\n\nEnviamos em 2 dias.', caracteres: 28, paginas: null, avisos: [] })
    const depois = (await chamar(T, 'GET', '/v1/agente/conhecimento?incluirDespublicados=true')).json() as { itens: Doc[] }
    expect(depois.itens.length).toBe(antes.itens.length)
  })

  it('POST extrair: tipo fora da lista → 422 campo_invalido; arquivo vazio → 422 conhecimento.sem_texto', async () => {
    const r1 = await chamar(T, 'POST', '/v1/agente/conhecimento/extrair', { nome: 'x.docx', tipo: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', conteudoBase64: 'AA==' })
    expect(r1.statusCode).toBe(422)
    expect((r1.json() as { erro: string }).erro).toBe('conhecimento.campo_invalido')
    const r2 = await chamar(T, 'POST', '/v1/agente/conhecimento/extrair', { nome: 'vazio.txt', tipo: 'text/plain', conteudoBase64: Buffer.from('   ').toString('base64') })
    expect(r2.statusCode).toBe(422)
    expect((r2.json() as { erro: string }).erro).toBe('conhecimento.sem_texto')
  })
})

describe('Listagem por cursor', () => {
  it('dado 23 documentos, então 20 na primeira página, 3 na segunda, e o cursor inválido é 422', async () => {
    for (let i = 0; i < 23; i++) {
      const r = await chamar(T, 'POST', '/v1/agente/conhecimento', { titulo: `Doc ${i}`, tipo: 'outro', conteudo: `Conteúdo número ${i}.` })
      expect(r.statusCode).toBe(201)
    }
    const p1 = (await chamar(T, 'GET', '/v1/agente/conhecimento')).json() as { itens: Doc[]; proximoCursor: string | null }
    expect(p1.itens).toHaveLength(20)
    expect(p1.proximoCursor).not.toBeNull()
    const p2 = (await chamar(T, 'GET', `/v1/agente/conhecimento?cursor=${p1.proximoCursor}`)).json() as { itens: Doc[]; proximoCursor: string | null }
    expect(p2.itens.length).toBeGreaterThanOrEqual(3)
    expect(p2.proximoCursor).toBeNull()
    const ids = new Set([...p1.itens, ...p2.itens].map((d) => d.id))
    expect(ids.size).toBe(p1.itens.length + p2.itens.length)
    expect((await chamar(T, 'GET', '/v1/agente/conhecimento?cursor=zzz')).statusCode).toBe(422)
  })

  it('dado canalId, então entram os globais e os do canal', async () => {
    const r = (await chamar(T, 'GET', `/v1/agente/conhecimento?canalId=${CANAL}`)).json() as { itens: Doc[] }
    expect(r.itens.length).toBeGreaterThan(0)
    for (const d of r.itens) expect(d.canalId === null || d.canalId === CANAL).toBe(true)
  })
})

describe('Espelho com agente_config.politicas', () => {
  it('PUT /canais/:id/agente com políticas cria o documento do canal; PATCH no documento escreve de volta', async () => {
    const put = await chamar(T, 'PUT', `/v1/canais/${CANAL}/agente`, { modo: 'sombra', politicas: 'Entrega em 3 dias úteis.\n\nPIX e cartão.' })
    expect(put.statusCode).toBe(200)
    const lista = (await chamar(T, 'GET', `/v1/agente/conhecimento?canalId=${CANAL}`)).json() as { itens: Doc[] }
    const pol = lista.itens.find((d) => d.tipo === 'politicas' && d.canalId === CANAL)!
    expect(pol).toMatchObject({ titulo: 'Políticas da loja', versao: 1, conteudo: 'Entrega em 3 dias úteis.\n\nPIX e cartão.' })

    // Salvar de novo sem mudar nada não cria segundo documento nem sobe versão.
    await chamar(T, 'PUT', `/v1/canais/${CANAL}/agente`, { modo: 'sombra', politicas: 'Entrega em 3 dias úteis.\n\nPIX e cartão.' })
    const [n] = await dono<{ n: number; versao: number }[]>`
      SELECT count(*)::int AS n, max(versao)::int AS versao FROM conhecimento_documento WHERE tenant_id = ${T} AND canal_id = ${CANAL} AND tipo = 'politicas'`
    expect(n).toEqual({ n: 1, versao: 1 })

    // PUT sem o campo politicas não mexe no documento.
    await chamar(T, 'PUT', `/v1/canais/${CANAL}/agente`, { modo: 'sombra' })
    expect((await dono<{ versao: number }[]>`SELECT versao FROM conhecimento_documento WHERE id = ${pol.id}`)[0]!.versao).toBe(1)

    const patch = await chamar(T, 'PATCH', `/v1/agente/conhecimento/${pol.id}`, { conteudo: 'Entrega em 2 dias úteis.' })
    expect(patch.json()).toMatchObject({ versao: 2 })
    const cfg = (await chamar(T, 'GET', `/v1/canais/${CANAL}/agente`)).json() as { politicas: string }
    expect(cfg.politicas).toBe('Entrega em 2 dias úteis.')

    // O espelho não muda de tipo nem de canal.
    expect((await chamar(T, 'PATCH', `/v1/agente/conhecimento/${pol.id}`, { tipo: 'faq' })).statusCode).toBe(422)
    expect((await chamar(T, 'PATCH', `/v1/agente/conhecimento/${pol.id}`, { canalId: null })).statusCode).toBe(422)
  })
})

describe('Testar a base', () => {
  it('POST /buscar devolve trechos com fonte "Título vN" e diz se a semântica estava ligada', async () => {
    const r = await chamar(T, 'POST', '/v1/agente/conhecimento/buscar', { pergunta: 'prazo de entrega', canalId: CANAL })
    expect(r.statusCode).toBe(200)
    const b = r.json() as { trechos: { texto: string; fonte: string; versao: number }[]; fontes: string[]; semantica: string }
    expect(b.trechos[0]!.texto).toMatch(/2 dias úteis/)
    expect(b.trechos[0]!.fonte).toBe('Políticas da loja v2')
    expect(b.fontes).toContain('lexical')
    expect(typeof b.semantica).toBe('string')
  })

  it('pergunta vazia → 422', async () => {
    expect((await chamar(T, 'POST', '/v1/agente/conhecimento/buscar', { pergunta: '' })).statusCode).toBe(422)
  })
})

describe('Isolamento — dois tenants', () => {
  it('o outro tenant não lista, não edita, não apaga nem acha os documentos do primeiro', async () => {
    const meus = (await chamar(T, 'GET', '/v1/agente/conhecimento')).json() as { itens: Doc[] }
    const alvo = meus.itens[0]!
    const lista = (await chamar(OUTRO, 'GET', '/v1/agente/conhecimento')).json() as { itens: Doc[] }
    expect(lista.itens).toEqual([])
    expect((await chamar(OUTRO, 'PATCH', `/v1/agente/conhecimento/${alvo.id}`, { titulo: 'invadido' })).statusCode).toBe(404)
    expect((await chamar(OUTRO, 'DELETE', `/v1/agente/conhecimento/${alvo.id}`)).statusCode).toBe(404)
    const busca = (await chamar(OUTRO, 'POST', '/v1/agente/conhecimento/buscar', { pergunta: 'prazo de entrega' })).json() as { trechos: unknown[] }
    expect(busca.trechos).toEqual([])
    expect((await dono<{ titulo: string }[]>`SELECT titulo FROM conhecimento_documento WHERE id = ${alvo.id}`)[0]!.titulo).toBe(alvo.titulo)
  })
})
