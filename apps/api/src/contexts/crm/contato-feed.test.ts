import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'

/**
 * A3 — feed do contato. Fixa: ordem (mais novo primeiro), todos os tipos, cursor sem repetir nem
 * pular (inclusive com instantes IGUAIS), isolamento entre tenants e — o essencial — que NUNCA sai
 * conteúdo de mensagem do WhatsApp.
 */
const T = 'a3f00000-0000-4000-8000-000000000001'
const OUTRO = 'a3f00000-0000-4000-8000-000000000002'
const PV = 'a3f00000-1111-4000-8000-000000000001'
const PV2 = 'a3f00000-1111-4000-8000-000000000002'
const PLANO = 'a3f00000-3333-4000-8000-000000000001'
const MODELO = 'a3f00000-4444-4000-8000-000000000001'
const C = 'a3f00000-5555-4000-8000-000000000001'
const C_CURSOR = 'a3f00000-5555-4000-8000-000000000002'
const C_OUTRO = 'a3f00000-5555-4000-8000-000000000003'
const CANAL = 'a3f00000-6666-4000-8000-000000000001'
const CONVERSA = 'a3f00000-7777-4000-8000-000000000001'
const SEGREDO = 'SEGREDO-DA-MENSAGEM-3917'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const chamar = (t: string, m: 'GET' | 'POST' | 'PUT', url: string, corpo?: Record<string, unknown>) =>
  app.inject({ method: m, url, headers: { 'x-tenant-id': t }, ...(corpo ? { payload: corpo } : {}) })
interface Item { id: string; tipo: string; em: string; autor: { id: string; nome: string } | null; texto: string; ref?: { tipo: string; id: string } }
interface Pagina { itens: Item[]; proximoCursor: string | null }
const feed = async (t: string, c: string, cursor?: string) => {
  const r = await chamar(t, 'GET', `/v1/contatos/${c}/feed${cursor ? `?cursor=${cursor}` : ''}`)
  return { status: r.statusCode, corpo: r.body, json: r.json() as Pagina }
}
const minutos = (m: number) => new Date(Date.now() - m * 60_000)

async function limpar() {
  for (const tb of ['carteira_atribuicao', 'comentario', 'tarefa', 'pedido', 'oportunidade_etapa_historico', 'oportunidade', 'agente_sessao', 'mensagem',
    'conversa', 'canal_conectado', 'contato_etiqueta', 'etiqueta', 'contato']) {
    await dono.unsafe(`DELETE FROM ${tb} WHERE tenant_id IN ('${T}', '${OUTRO}')`)
  }
  await dono`DELETE FROM auditoria WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM funil_etapa WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM motivo_perda WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM usuario WHERE tenant_id IN (${T}, ${OUTRO})`
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-a3f', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-a3f', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'A'], [OUTRO, PV2, 'B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await limpar()
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES
    (${T}, ${C}, 'Zé do Feed', 'teste', true), (${T}, ${C_CURSOR}, 'Paginado', 'teste', true), (${OUTRO}, ${C_OUTRO}, 'De Outro', 'teste', true)`
  app = await criarApp(); await app.ready()
})

afterAll(async () => {
  await limpar()
  for (const t of [T, OUTRO]) {
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('A3 — feed do contato', () => {
  it('unifica os tipos, mais novo primeiro, sem conteúdo de mensagem', async () => {
    const [ator] = await dono<{ id: string }[]>`
      INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${T}, ${randomUUID()}, 'sub-a3f', 'Vera', 'vera@a3f.test') RETURNING id`
    const eu = ator!.id
    await dono`INSERT INTO comentario (tenant_id, id, contato_id, autor_id, texto, criado_em)
               VALUES (${T}, ${randomUUID()}, ${C}, ${eu}, 'Pediu catálogo novo', ${minutos(120)})`
    const tarefa = randomUUID()
    await dono`INSERT INTO tarefa (tenant_id, id, contato_id, titulo, vence_em, estado, criado_por, criado_em, concluida_em, resultado, concluida_por)
               VALUES (${T}, ${tarefa}, ${C}, 'Ligar de volta', now(), 'concluida', ${eu}, ${minutos(110)}, ${minutos(100)}, 'Fechou o combo', ${eu})`
    const pedido = randomUUID()
    await dono`INSERT INTO pedido (tenant_id, id, contato_id, vendedor_id, estado, criado_em, efetivado_em, numero_externo)
               VALUES (${T}, ${pedido}, ${C}, ${eu}, 'efetivado', ${minutos(90)}, ${minutos(80)}, 'ERP-77')`
    // Funil: etapa + histórico + oportunidade perdida (com motivo).
    const [etapa] = await dono<{ id: string }[]>`
      INSERT INTO funil_etapa (tenant_id, id, ordem, chave, nome, tipo) VALUES (${T}, ${randomUUID()}, 1, 'conversa', 'Em conversa', 'aberto') RETURNING id`
    await dono`INSERT INTO motivo_perda (tenant_id, codigo, nome) VALUES (${T}, 'preco', 'Preço') ON CONFLICT DO NOTHING`
    const op = randomUUID()
    await dono`INSERT INTO oportunidade (tenant_id, id, contato_id, etapa_id, estado, motivo_perda_codigo, fechada_em)
               VALUES (${T}, ${op}, ${C}, ${etapa!.id}, 'perdida', 'preco', ${minutos(60)})`
    await dono`INSERT INTO oportunidade_etapa_historico (tenant_id, id, oportunidade_id, etapa_id, entrou_em, ator_id)
               VALUES (${T}, ${randomUUID()}, ${op}, ${etapa!.id}, ${minutos(70)}, ${eu})`
    // Conversa + mensagem COM segredo + auditoria de handoff.
    await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado)
               VALUES (${T}, ${CANAL}, 'whatsapp_nao_oficial', 'plugzapi', 'Canal A3', 'conectado')`
    await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao, conduzida_por) VALUES (${T}, ${CONVERSA}, ${CANAL}, ${C}, 0, 'humano')`
    await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo)
               VALUES (${T}, ${randomUUID()}, ${CONVERSA}, 'entrante', 'texto', ${dono.json({ texto: SEGREDO })})`
    await dono`INSERT INTO auditoria (tenant_id, id, criado_em, ator_id, acao, entidade, entidade_id, dados) VALUES
      (${T}, ${randomUUID()}, ${minutos(50)}, ${eu}, 'atendimento.reatribuido', 'conversa', ${CONVERSA}, ${dono.json({ para: eu, motivo: SEGREDO })}),
      (${T}, ${randomUUID()}, ${minutos(40)}, ${eu}, 'conversa.devolvida_ao_agente', 'conversa', ${CONVERSA}, ${dono.json({ destino: 'agente', observacao: SEGREDO })})`
    // Qualificação e etiquetas passam pelas rotas (é o que grava o rastro).
    expect((await chamar(T, 'POST', `/v1/leads/${C}/qualificar`, { estado: 'qualificado' })).statusCode).toBe(200)
    const [et] = await dono<{ id: string }[]>`
      INSERT INTO etiqueta (tenant_id, id, nome, cor) VALUES (${T}, ${randomUUID()}, 'VIP', 'acao') RETURNING id`
    expect((await chamar(T, 'PUT', `/v1/contatos/${C}/etiquetas`, { etiquetaIds: [et!.id] })).statusCode).toBe(200)

    const r = await feed(T, C)
    expect(r.status).toBe(200)
    expect(r.corpo).not.toContain(SEGREDO)
    const tipos = new Set(r.json.itens.map((i) => i.tipo))
    for (const t of ['comentario', 'funil', 'qualificacao', 'tarefa_criada', 'tarefa_concluida', 'pedido_criado', 'pedido_efetivado', 'handoff', 'etiquetas']) {
      expect(tipos.has(t), t).toBe(true)
    }
    const ems = r.json.itens.map((i) => Date.parse(i.em))
    expect(ems).toEqual([...ems].sort((a, b) => b - a))
    // Os dois últimos fatos (qualificação e etiquetas) vêm antes dos semeados no passado.
    expect(['qualificacao', 'etiquetas']).toContain(r.json.itens[0]!.tipo)

    const por = (tipo: string) => r.json.itens.filter((i) => i.tipo === tipo)
    expect(por('comentario')[0]).toMatchObject({ texto: 'Pediu catálogo novo', autor: { nome: 'Vera' } })
    expect(por('tarefa_concluida')[0]!.texto).toContain('Fechou o combo')
    expect(por('tarefa_concluida')[0]!.ref).toEqual({ tipo: 'tarefa', id: tarefa })
    expect(por('pedido_efetivado')[0]!.texto).toContain('ERP-77')
    expect(por('pedido_criado')[0]!.ref).toEqual({ tipo: 'pedido', id: pedido })
    expect(por('funil').map((i) => i.texto).join('|')).toContain('Oportunidade perdida: Preço')
    expect(por('qualificacao')[0]!.texto).toBe('Contato qualificado')
    expect(por('etiquetas')[0]!.texto).toContain('adicionou VIP')
    expect(por('handoff').map((i) => i.texto)).toEqual(expect.arrayContaining(['Conversa reatribuída para Vera', 'Conversa devolvida ao agente']))
  })

  it('aba WhatsApp: resumo das últimas mensagens da conversa mais recente (fora do feed); sem conversa → vazio', async () => {
    const r = (await chamar(T, 'GET', `/v1/contatos/${C}/whatsapp`)).json() as {
      conversa: { id: string; canal: string } | null; mensagens: { direcao: string; resumo: string }[]
    }
    expect(r.conversa).toMatchObject({ id: CONVERSA, canal: 'Canal A3' })
    expect(r.mensagens[0]).toMatchObject({ direcao: 'entrante', resumo: SEGREDO })
    expect((await chamar(T, 'GET', `/v1/contatos/${C_CURSOR}/whatsapp`)).json()).toEqual({ conversa: null, mensagens: [] })
    expect((await chamar(OUTRO, 'GET', `/v1/contatos/${C}/whatsapp`)).statusCode).toBe(404)
  })

  it('a ficha traz criadoEm, origem e vendedor da carteira', async () => {
    const [u] = await dono<{ id: string }[]>`SELECT id FROM usuario WHERE tenant_id = ${T} AND nome = 'Vera'`
    await dono`INSERT INTO carteira_atribuicao (tenant_id, id, contato_id, usuario_id, origem) VALUES (${T}, ${randomUUID()}, ${C}, ${u!.id}, 'manual')`
    const f = (await chamar(T, 'GET', `/v1/contatos/${C}`)).json() as { criadoEm: string; origem: string | null; vendedor: { nome: string } | null }
    expect(f.vendedor).toMatchObject({ nome: 'Vera' })
    expect(Date.parse(f.criadoEm)).toBeGreaterThan(0)
    expect(f.origem).toBeNull()
    await dono`DELETE FROM carteira_atribuicao WHERE tenant_id = ${T}`
  })

  it('cursor: pagina sem repetir nem pular, mesmo com instantes idênticos', async () => {
    const quando = minutos(30)
    for (let i = 0; i < 70; i++) {
      await dono`INSERT INTO comentario (tenant_id, id, contato_id, texto, criado_em) VALUES (${T}, ${randomUUID()}, ${C_CURSOR}, ${'c' + i}, ${quando})`
    }
    // Ramo da auditoria (cursor com `criado_em <= …` e id prefixado) no MESMO instante dos comentários.
    for (let i = 0; i < 35; i++) {
      await dono`INSERT INTO auditoria (tenant_id, id, criado_em, acao, entidade, entidade_id, dados)
                 VALUES (${T}, ${randomUUID()}, ${quando}, 'contato.arquivo_enviado', 'contato', ${C_CURSOR}, ${dono.json({ nome: 'a' + i })})`
    }
    const vistos: string[] = []
    let cursor: string | undefined
    let paginas = 0
    do {
      const r = await feed(T, C_CURSOR, cursor)
      expect(r.status).toBe(200)
      expect(r.json.itens.length).toBeLessThanOrEqual(30)
      vistos.push(...r.json.itens.map((i) => i.id))
      cursor = r.json.proximoCursor ?? undefined
      paginas += 1
    } while (cursor && paginas < 10)
    expect(paginas).toBe(4)
    expect(vistos.length).toBe(105)
    expect(new Set(vistos).size).toBe(105)
  })

  it('cursor inválido → 422; contato inexistente → 404', async () => {
    expect((await chamar(T, 'GET', `/v1/contatos/${C}/feed?cursor=lixo`)).statusCode).toBe(422)
    expect((await chamar(T, 'GET', `/v1/contatos/${randomUUID()}/feed`)).statusCode).toBe(404)
  })

  it('RLS: contato de outro tenant dá 404 e o feed de um não mostra itens do outro', async () => {
    await dono`INSERT INTO comentario (tenant_id, id, contato_id, texto) VALUES (${OUTRO}, ${randomUUID()}, ${C_OUTRO}, 'só do outro')`
    expect((await feed(T, C_OUTRO)).status).toBe(404)
    const deles = await feed(OUTRO, C_OUTRO)
    expect(deles.json.itens.map((i) => i.texto)).toEqual(['só do outro'])
    expect((await feed(T, C)).corpo).not.toContain('só do outro')
  })
})
