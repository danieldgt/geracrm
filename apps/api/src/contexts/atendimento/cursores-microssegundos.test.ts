import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'

/**
 * Cursores do atendimento preservam MICROSSEGUNDOS.
 *
 * ⚠️ O Postgres guarda µs; `Date#toISOString()` corta em ms. Com o cursor montado
 *    pelo Date (e lido com `::timestamptz` direto, que o driver também serializa
 *    via Date), dois itens no mesmo milissegundo, um de cada lado da fronteira
 *    da página, quebravam a paginação: em lista DESC o da página seguinte sumia;
 *    em lista ASC o último da página voltava repetido. A conversa de 11 mil cards
 *    é justamente onde dois eventos caem no mesmo ms.
 *
 * Cada lista recebe P+2 linhas (P = tamanho da página): P-1 longe da fronteira,
 * as duas da fronteira no MESMO ms (diferem só em µs) e uma depois. Percorrer
 * todas as páginas tem de devolver exatamente as P+2, na ordem, sem repetir.
 *
 * ⚠️ UUIDs exclusivos deste arquivo (prefixo cc5e0000).
 */
const T = 'cc5e0000-0000-4000-8000-000000000001'
const PV = 'cc5e0000-1111-4000-8000-000000000001'
const PLANO = 'cc5e0000-3333-4000-8000-000000000001'
const MODELO = 'cc5e0000-4444-4000-8000-000000000001'
const CANAL = 'cc5e0000-7777-4000-8000-000000000001'
const ETAPA = 'cc5e0000-2222-4000-8000-000000000001'
const CONTATO_LOG = 'cc5e0000-5555-4000-8000-000000000001'
const CONV_LOG = 'cc5e0000-6666-4000-8000-000000000001'
const CONTATO_HIST = 'cc5e0000-5555-4000-8000-000000000002'
const CONV_HIST = 'cc5e0000-6666-4000-8000-000000000002'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const chamar = (url: string) => app.inject({ method: 'GET', url, headers: { 'x-tenant-id': T } })

/** Ontem (UTC): dentro de uma partição de `mensagem` que existe e longe de "agora". */
const DIA = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
const pad = (n: number) => String(n).padStart(2, '0')

/** P+2 instantes na ordem em que a lista DESC os devolve. Fronteira: índices P-1 e P. */
function temposDesc(p: number): string[] {
  const longe = Array.from({ length: p - 1 }, (_, i) => `${DIA} 12:${pad(Math.floor((p - 1 - i) / 60))}:${pad((p - 1 - i) % 60)}.000000+00`)
  return [...longe, `${DIA} 11:00:00.000200+00`, `${DIA} 11:00:00.000100+00`, `${DIA} 10:00:00.000000+00`]
}

/** P+2 instantes na ordem em que a lista ASC os devolve. Fronteira: índices P-1 e P. */
function temposAsc(p: number): string[] {
  const longe = Array.from({ length: p - 1 }, (_, i) => `${DIA} 10:${pad(Math.floor(i / 60))}:${pad(i % 60)}.000000+00`)
  return [...longe, `${DIA} 11:00:00.000100+00`, `${DIA} 11:00:00.000200+00`, `${DIA} 12:00:00.000000+00`]
}

const ids = (n: number) => Array.from({ length: n }, () => randomUUID())

/** Segue `proximoCursor` até o fim; devolve os ids na ordem em que vieram. */
async function percorrer(url: string, campoId = 'id'): Promise<{ ids: string[]; paginas: number }> {
  const vistos: string[] = []
  let cursor: string | null = null
  for (let paginas = 1; paginas <= 10; paginas++) {
    const sep = url.includes('?') ? '&' : '?'
    const r = await chamar(cursor ? `${url}${sep}cursor=${cursor}` : url)
    expect(r.statusCode, r.body).toBe(200)
    const corpo = r.json() as { itens: Record<string, string>[]; proximoCursor: string | null }
    vistos.push(...corpo.itens.map((i) => i[campoId]!))
    cursor = corpo.proximoCursor
    if (cursor === null) return { ids: vistos, paginas }
  }
  throw new Error('paginação não terminou em 10 páginas')
}

// Conversas: uma por contato (UNIQUE canal+contato). As mesmas servem à lista do inbox
// e à fila "Aguardando" (entrante sem atendimento aberto), ambas DESC por ultima_mensagem_em.
const P_CONVERSAS = 50
const CONVERSAS = ids(P_CONVERSAS + 2)
const T_CONVERSAS = temposDesc(P_CONVERSAS)
// Coluna do kanban: ASC por entrou_etapa_em, página de 50. Um atendimento (encerrado — o
// índice "um aberto por conversa" não pesa) por conversa, na etapa do teste.
const P_COLUNA = 50
const ATENDIMENTOS = ids(P_COLUNA + 2)
const T_COLUNA = temposAsc(P_COLUNA)
const P_TEMPLATES = 50
const TEMPLATES = ids(P_TEMPLATES + 2)
const T_TEMPLATES = temposDesc(P_TEMPLATES)
const P_LOG = 30
const MENSAGENS_LOG = ids(P_LOG + 2)
const T_LOG = temposDesc(P_LOG)
const P_AGENTE = 20
const SESSOES = ids(P_AGENTE + 2)
const T_SESSOES = temposDesc(P_AGENTE)
const DECISOES = ids(P_AGENTE + 2)
const T_DECISOES = temposDesc(P_AGENTE)
const DOCUMENTOS = ids(P_AGENTE + 2)
const T_DOCUMENTOS = temposDesc(P_AGENTE)

async function limpar(): Promise<void> {
  for (const t of ['agente_decisao', 'agente_sessao', 'conhecimento_trecho', 'conhecimento_documento_versao', 'conhecimento_documento',
    'template_versao', 'template', 'mensagem', 'atendimento_etapa_historico', 'atendimento', 'atendimento_etapa', 'conversa',
    'contato', 'canal_conectado']) {
    await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id = '${T}'`).catch((e: { code?: string }) => {
      if (e.code !== '42P01') throw e // tabela opcional ausente nesta base
    })
  }
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-cursores-micro', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-cursores-micro', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'Loja Cursores', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await limpar()
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado)
             VALUES (${T}, ${CANAL}, 'whatsapp_oficial', 'Zap', 'conectado')`

  // Conversas da fila/inbox, cada uma com o próprio contato.
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo)
             SELECT ${T}, x.id, 'Cliente ' || x.n, 'teste', true
               FROM unnest(${CONVERSAS}::uuid[]) WITH ORDINALITY AS x(id, n)`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, ultima_direcao, ultima_mensagem_em)
             SELECT ${T}, x.id, ${CANAL}, x.id, 'entrante', x.em::timestamptz
               FROM unnest(${CONVERSAS}::uuid[], ${T_CONVERSAS}::text[]) AS x(id, em)`

  await dono`INSERT INTO atendimento_etapa (tenant_id, id, ordem, chave, nome, tipo)
             VALUES (${T}, ${ETAPA}, 1, 'cursores_micro', 'Cursores', 'atendimento')`
  await dono`INSERT INTO atendimento (tenant_id, id, conversa_id, canal_id, protocolo, estado, etapa_id, entrou_etapa_em)
             SELECT ${T}, x.id, c.id, ${CANAL}, 900000 + x.n, 'encerrado', ${ETAPA}, x.em::timestamptz
               FROM unnest(${ATENDIMENTOS}::uuid[], ${T_COLUNA}::text[]) WITH ORDINALITY AS x(id, em, n)
               JOIN unnest(${CONVERSAS}::uuid[]) WITH ORDINALITY AS c(id, n) ON c.n = x.n`

  await dono`INSERT INTO template (tenant_id, id, nome, categoria, criado_em)
             SELECT ${T}, x.id, 'micro_' || x.n, 'MARKETING', x.em::timestamptz
               FROM unnest(${TEMPLATES}::uuid[], ${T_TEMPLATES}::text[]) WITH ORDINALITY AS x(id, em, n)`
  await dono`INSERT INTO template_versao (tenant_id, template_id, versao, corpo)
             SELECT ${T}, x.id, 1, '{"body":{"texto":"oi"}}'::jsonb FROM unnest(${TEMPLATES}::uuid[]) AS x(id)`

  // Log de enviadas e agente: tudo numa conversa só.
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES (${T}, ${CONTATO_LOG}, 'Cliente Log', 'teste', true)`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, arquivada) VALUES (${T}, ${CONV_LOG}, ${CANAL}, ${CONTATO_LOG}, true)`
  await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, status, status_ordem, criado_em)
             SELECT ${T}, x.id, ${CONV_LOG}, 'saliente', 'texto', '{"texto":"oi"}'::jsonb, 'enviada', 0, x.em::timestamptz
               FROM unnest(${MENSAGENS_LOG}::uuid[], ${T_LOG}::text[]) AS x(id, em)`
  await dono`INSERT INTO agente_sessao (tenant_id, id, conversa_id, canal_id, estado, encerrada_em, motivo_saida, iniciada_em)
             SELECT ${T}, x.id, ${CONV_LOG}, ${CANAL}, 'encerrada', x.em::timestamptz, 'teste', x.em::timestamptz
               FROM unnest(${SESSOES}::uuid[], ${T_SESSOES}::text[]) AS x(id, em)`
  await dono`INSERT INTO agente_decisao (tenant_id, id, conversa_id, canal_id, modo, desfecho, criado_em)
             SELECT ${T}, x.id, ${CONV_LOG}, ${CANAL}, 'sombra', 'respondeu', x.em::timestamptz
               FROM unnest(${DECISOES}::uuid[], ${T_DECISOES}::text[]) AS x(id, em)`
  await dono`INSERT INTO conhecimento_documento (tenant_id, id, titulo, tipo, conteudo, atualizado_em)
             SELECT ${T}, x.id, 'Doc ' || x.n, 'faq', 'Conteúdo ' || x.n, x.em::timestamptz
               FROM unnest(${DOCUMENTOS}::uuid[], ${T_DOCUMENTOS}::text[]) WITH ORDINALITY AS x(id, em, n)`

  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES (${T}, ${CONTATO_HIST}, 'Cliente Histórico', 'teste', true)`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, arquivada) VALUES (${T}, ${CONV_HIST}, ${CANAL}, ${CONTATO_HIST}, true)`

  app = await criarApp(); await app.ready()
})

afterAll(async () => {
  await limpar()
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${T}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${T}`
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('Cursores do atendimento — itens no mesmo milissegundo na fronteira da página', () => {
  it('GET /v1/conversas: nenhuma conversa some na virada', async () => {
    const r = await percorrer(`/v1/conversas?limite=${P_CONVERSAS}`)
    expect(r.ids).toEqual(CONVERSAS)
    expect(r.paginas).toBe(2)
  })

  it('GET /v1/atendimento-kanban/aguardando: nenhuma conversa some da fila', async () => {
    const r = await percorrer('/v1/atendimento-kanban/aguardando', 'conversaId')
    expect(r.ids).toEqual(CONVERSAS)
  })

  it('GET /v1/atendimento-kanban/coluna/:etapa (ASC): o último da página não volta repetido', async () => {
    const r = await percorrer(`/v1/atendimento-kanban/coluna/${ETAPA}`, 'atendimentoId')
    expect(r.ids).toEqual(ATENDIMENTOS)
  })

  it('GET /v1/templates', async () => {
    expect((await percorrer('/v1/templates')).ids).toEqual(TEMPLATES)
  })

  it('GET /v1/mensagens-enviadas', async () => {
    expect((await percorrer('/v1/mensagens-enviadas')).ids).toEqual(MENSAGENS_LOG)
  })

  it('GET /v1/agente/sessoes', async () => {
    expect((await percorrer('/v1/agente/sessoes')).ids).toEqual(SESSOES)
  })

  it('GET /v1/agente/decisoes', async () => {
    expect((await percorrer(`/v1/agente/decisoes?conversaId=${CONV_LOG}`)).ids).toEqual(DECISOES)
  })

  it('GET /v1/agente/conhecimento', async () => {
    expect((await percorrer('/v1/agente/conhecimento')).ids).toEqual(DOCUMENTOS)
  })

  it('cursor malformado → 422 em todas (antes, data inválida virava 500 no banco)', async () => {
    const lixo = Buffer.from('2026-02-30 10:00:00+00§' + randomUUID()).toString('base64url')
    for (const url of ['/v1/conversas', '/v1/atendimento-kanban/aguardando', `/v1/atendimento-kanban/coluna/${ETAPA}`,
      '/v1/templates', '/v1/mensagens-enviadas', '/v1/agente/sessoes', '/v1/agente/decisoes', '/v1/agente/conhecimento']) {
      const r = await chamar(`${url}${url.includes('?') ? '&' : '?'}cursor=${lixo}`)
      expect(r.statusCode, url).toBe(422)
      expect((r.json() as { erro: string }).erro, url).toBe('cursor.invalido')
    }
  })

  it('cursor antigo (ISO em ms, emitido antes do deploy) continua aceito', async () => {
    const antigo = Buffer.from(`${DIA}T12:00:30.000Z§${randomUUID()}`).toString('base64url')
    expect((await chamar(`/v1/mensagens-enviadas?cursor=${antigo}`)).statusCode).toBe(200)
  })
})

describe('GET /v1/conversas/:id/mensagens — histórico para trás', () => {
  /**
   * O cursor vem do CLIENTE: `criadoEm` da mensagem mais antiga que ele tem, que
   * chegou serializada pelo Date (ms). O servidor recupera o instante exato da
   * âncora pelo id — senão a mensagem do mesmo ms, mais antiga em µs, nunca aparece.
   */
  const [ANTES, MESMO_MS_ANTES, ANCORA, MESMO_MS_DEPOIS] = ids(4) as [string, string, string, string]

  beforeAll(async () => {
    const linhas: [string, string][] = [
      [ANTES, `${DIA} 09:00:00.000000+00`],
      [MESMO_MS_ANTES, `${DIA} 09:30:00.123100+00`],
      [ANCORA, `${DIA} 09:30:00.123300+00`],
      [MESMO_MS_DEPOIS, `${DIA} 09:30:00.123400+00`],
    ]
    for (const [id, em] of linhas) {
      await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
                 VALUES (${T}, ${id}, ${CONV_HIST}, 'entrante', 'texto', '{"texto":"oi"}'::jsonb, ${em}::text::timestamptz)`
    }
  })

  const historico = async (anteriorEm: string, anteriorId: string) => {
    const r = await chamar(`/v1/conversas/${CONV_HIST}/mensagens?anteriorEm=${encodeURIComponent(anteriorEm)}&anteriorId=${anteriorId}`)
    expect(r.statusCode, r.body).toBe(200)
    return (r.json() as { mensagens: { id: string }[] }).mensagens.map((m) => m.id)
  }

  it('dado âncora em ms (como o console manda), então traz a do mesmo ms mais antiga e não a mais nova', async () => {
    const comoOConsoleManda = new Date(`${DIA}T09:30:00.123Z`).toISOString()
    expect(await historico(comoOConsoleManda, ANCORA)).toEqual([ANTES, MESMO_MS_ANTES])
  })

  it('dado âncora desconhecida, então cai no instante que veio (comportamento anterior, sem erro)', async () => {
    expect(await historico(`${DIA}T09:30:00.124Z`, randomUUID())).toEqual([ANTES, MESMO_MS_ANTES, ANCORA, MESMO_MS_DEPOIS])
  })

  it('dado instante inválido, então 422', async () => {
    const r = await chamar(`/v1/conversas/${CONV_HIST}/mensagens?anteriorEm=2026-02-30&anteriorId=${ANCORA}`)
    expect(r.statusCode).toBe(422)
  })
})
