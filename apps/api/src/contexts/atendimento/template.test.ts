import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'

/** Templates (HSM): criar rascunho PENDING, unicidade nome+idioma, nova versão,
 *  apagar só se não submetido, isolamento por tenant. */
const T = 'b1000000-0000-4000-8000-000000000001'
const OUTRO = 'b1000000-0000-4000-8000-000000000002'
const PV = 'b1000000-1111-4000-8000-000000000001'
const PV2 = 'b1000000-1111-4000-8000-000000000002'
const PLANO = 'b1000000-3333-4000-8000-000000000001'
const MODELO = 'b1000000-4444-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const chamar = (t: string, m: 'GET' | 'POST' | 'DELETE', url: string, corpo?: Record<string, unknown>) =>
  app.inject({ method: m, url, headers: { 'x-tenant-id': t }, ...(corpo ? { payload: corpo } : {}) })
const CORPO = { header: { texto: 'Novidades' }, body: { texto: 'Olá {{1}}, chegou reposição.' }, footer: { texto: 'Loja X' } }

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-tpl', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-tpl', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'A'], [OUTRO, PV2, 'B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  app = await criarApp(); await app.ready()
})

beforeEach(async () => {
  await dono`DELETE FROM template_versao WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM template WHERE tenant_id IN (${T}, ${OUTRO})`
})

afterAll(async () => {
  await dono`DELETE FROM template_versao WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM template WHERE tenant_id IN (${T}, ${OUTRO})`
  for (const t of [T, OUTRO]) {
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

const criar = (t: string, nome: string, extra?: Record<string, unknown>) =>
  chamar(t, 'POST', '/v1/templates', { nome, categoria: 'MARKETING', corpo: CORPO, ...extra })

describe('Templates (HSM)', () => {
  it('cria rascunho PENDING v1 e aparece no catálogo', async () => {
    const r = await criar(T, 'reposicao_mensal')
    expect(r.statusCode).toBe(201)
    const lista = (await chamar(T, 'GET', '/v1/templates')).json() as {
      itens: { id: string; nome: string; versao: number; statusMeta: string; categoria: string; submetido: boolean }[]
    }
    expect(lista.itens.length).toBe(1)
    expect(lista.itens[0]).toMatchObject({ nome: 'reposicao_mensal', versao: 1, statusMeta: 'PENDING', categoria: 'MARKETING', submetido: false })
  })

  it('nome+idioma duplicado → 409; nome/categoria/corpo inválidos → 422', async () => {
    expect((await criar(T, 'promo')).statusCode).toBe(201)
    expect((await criar(T, 'promo')).statusCode).toBe(409)
    expect((await chamar(T, 'POST', '/v1/templates', { nome: 'Promo Maiúscula', categoria: 'MARKETING', corpo: CORPO })).statusCode).toBe(422)
    expect((await chamar(T, 'POST', '/v1/templates', { nome: 'x', categoria: 'INEXISTENTE', corpo: CORPO })).statusCode).toBe(422)
    expect((await chamar(T, 'POST', '/v1/templates', { nome: 'sem_corpo', categoria: 'UTILITY', corpo: { body: { texto: '' } } })).statusCode).toBe(422)
  })

  it('editar cria nova versão; o catálogo mostra a última', async () => {
    const id = (await criar(T, 'aviso')).json() as { id: string }
    const nova = await chamar(T, 'POST', `/v1/templates/${id.id}/versao`, { corpo: { body: { texto: 'Texto revisado {{1}}' } } })
    expect(nova.statusCode).toBe(201)
    expect((nova.json() as { versao: number }).versao).toBe(2)
    const det = (await chamar(T, 'GET', `/v1/templates/${id.id}`)).json() as { versoes: { versao: number }[] }
    expect(det.versoes.map((v) => v.versao)).toEqual([2, 1])
    const lista = (await chamar(T, 'GET', '/v1/templates')).json() as { itens: { versao: number }[] }
    expect(lista.itens[0]!.versao).toBe(2)
  })

  it('apaga rascunho não submetido; submetido (id_externo) → 409', async () => {
    const id = ((await criar(T, 'descartavel')).json() as { id: string }).id
    // Simula submissão à Meta.
    await dono`UPDATE template_versao SET id_externo = 'meta-123' WHERE tenant_id = ${T} AND template_id = ${id}`
    expect((await chamar(T, 'DELETE', `/v1/templates/${id}`)).statusCode).toBe(409)
    // Sem id_externo → apaga.
    const id2 = ((await criar(T, 'apagavel')).json() as { id: string }).id
    expect((await chamar(T, 'DELETE', `/v1/templates/${id2}`)).statusCode).toBe(200)
  })

  it('⚠️ isolamento: um tenant não vê nem apaga template do outro', async () => {
    const id = ((await criar(T, 'privado')).json() as { id: string }).id
    await criar(OUTRO, 'do_outro')
    const listaOutro = (await chamar(OUTRO, 'GET', '/v1/templates')).json() as { itens: { nome: string }[] }
    expect(listaOutro.itens.map((i) => i.nome)).toEqual(['do_outro'])
    expect((await chamar(OUTRO, 'DELETE', `/v1/templates/${id}`)).statusCode).toBe(404)
  })
})

describe('Templates — filtros no servidor (status, categoria, canalId, q)', () => {
  const CANAL_OFICIAL = 'b1000000-5555-4000-8000-000000000001'
  const CANAL_NAO_OFICIAL = 'b1000000-5555-4000-8000-000000000002'
  const CANAL_DE_OUTRO = 'b1000000-5555-4000-8000-000000000003'

  beforeAll(async () => {
    await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES
      (${T}, ${CANAL_OFICIAL}, 'whatsapp_oficial', 'Oficial', 'conectado'),
      (${T}, ${CANAL_NAO_OFICIAL}, 'whatsapp_nao_oficial', 'Não oficial', 'conectado'),
      (${OUTRO}, ${CANAL_DE_OUTRO}, 'whatsapp_oficial', 'Do outro', 'conectado')`
  })
  afterAll(async () => {
    await dono`DELETE FROM canal_conectado WHERE tenant_id IN (${T}, ${OUTRO})`
  })

  /** Template criado pela API (PENDING v1) e, se preciso, com o status da versão ajustado no banco. */
  async function semear(t: string, nome: string, status: string, categoria = 'MARKETING'): Promise<string> {
    const r = await criar(t, nome, { categoria })
    expect(r.statusCode).toBe(201)
    const id = (r.json() as { id: string }).id
    if (status !== 'PENDING') {
      await dono`UPDATE template_versao SET status_meta = ${status} WHERE tenant_id = ${t} AND template_id = ${id}`
    }
    return id
  }

  /** Semeia direto no banco (volume para testar paginação; a API não é o caminho aqui). */
  async function semearDireto(t: string, nome: string, status: string): Promise<void> {
    const id = randomUUID()
    await dono`INSERT INTO template (tenant_id, id, nome, categoria) VALUES (${t}, ${id}, ${nome}, 'MARKETING')`
    await dono`INSERT INTO template_versao (tenant_id, template_id, versao, corpo, status_meta)
               VALUES (${t}, ${id}, 1, ${JSON.stringify(CORPO)}::jsonb, ${status})`
  }

  const nomesDe = async (qs: string, t = T): Promise<string[]> =>
    ((await chamar(t, 'GET', `/v1/templates${qs}`)).json() as { itens: { nome: string }[] }).itens.map((i) => i.nome).sort()

  it('status filtra pela ÚLTIMA versão: nova versão PENDING tira o template do APPROVED', async () => {
    const id = await semear(T, 'reativado', 'APPROVED')
    await semear(T, 'pendente', 'PENDING')
    expect((await chamar(T, 'POST', `/v1/templates/${id}/versao`, { corpo: CORPO })).statusCode).toBe(201)
    expect(await nomesDe('?status=APPROVED')).toEqual([])
    expect(await nomesDe('?status=PENDING')).toEqual(['pendente', 'reativado'])
  })

  it('status e categoria combinam (AND); cada um aceita só o valor que a tabela guarda', async () => {
    await semear(T, 'mkt_ok', 'APPROVED', 'MARKETING')
    await semear(T, 'util_ok', 'APPROVED', 'UTILITY')
    await semear(T, 'mkt_pend', 'PENDING', 'MARKETING')
    expect(await nomesDe('?status=APPROVED&categoria=MARKETING')).toEqual(['mkt_ok'])
    expect(await nomesDe('?categoria=UTILITY')).toEqual(['util_ok'])
    expect(await nomesDe('?status=APPROVED&categoria=UTILITY')).toEqual(['util_ok'])
  })

  it('q casa parte do nome sem caixa, combina com os outros filtros; espaços não filtram', async () => {
    await semear(T, 'promo_verao', 'APPROVED')
    await semear(T, 'promo_inverno', 'PENDING')
    await semear(T, 'reposicao', 'APPROVED')
    expect(await nomesDe('?q=PROMO')).toEqual(['promo_inverno', 'promo_verao'])
    expect(await nomesDe('?q=promo&status=APPROVED&categoria=MARKETING')).toEqual(['promo_verao'])
    expect(await nomesDe('?q=%20%20')).toEqual(['promo_inverno', 'promo_verao', 'reposicao'])
  })

  it('escapa % e _ no q: o termo é texto literal, não curinga', async () => {
    await semear(T, 'promo_verao', 'APPROVED')
    await semear(T, 'promoxverao', 'APPROVED')
    expect(await nomesDe('?q=o_v')).toEqual(['promo_verao'])
    expect(await nomesDe('?q=_')).toEqual(['promo_verao'])
    expect(await nomesDe('?q=%25')).toEqual([])
    expect(await nomesDe('?q=%5C')).toEqual([])
  })

  it('valor inválido → 422 com campos, por filtro; q acima de 100 caracteres também', async () => {
    const casos: [string, string][] = [
      ['?status=approved', 'status'], ['?status=', 'status'], ['?status=ATIVO', 'status'],
      ['?categoria=MARKETINGX', 'categoria'], ['?canalId=nao-e-uuid', 'canalId'],
      [`?q=${'a'.repeat(101)}`, 'q'],
    ]
    for (const [qs, campo] of casos) {
      const r = await chamar(T, 'GET', `/v1/templates${qs}`)
      expect(r.statusCode, qs).toBe(422)
      expect(r.json(), qs).toMatchObject({ erro: 'template.filtro_invalido', campos: { [campo]: expect.any(String) } })
    }
  })

  it('canalId: oficial lista o catálogo do tenant; não oficial não envia template → vazio; canal alheio ou inexistente → 422', async () => {
    await semear(T, 'aprovado_x', 'APPROVED')
    expect(await nomesDe(`?canalId=${CANAL_OFICIAL}`)).toEqual(['aprovado_x'])
    expect(await nomesDe(`?canalId=${CANAL_NAO_OFICIAL}`)).toEqual([])
    const alheio = await chamar(T, 'GET', `/v1/templates?canalId=${CANAL_DE_OUTRO}`)
    expect(alheio.statusCode).toBe(422)
    expect(alheio.json()).toMatchObject({ campos: { canalId: expect.any(String) } })
    expect((await chamar(T, 'GET', `/v1/templates?canalId=${randomUUID()}`)).statusCode).toBe(422)
  })

  it('isolamento: com filtros e canal, cada tenant vê só o próprio catálogo', async () => {
    const meu = await semear(T, 'promo_verao', 'APPROVED')
    await semear(OUTRO, 'promo_verao', 'APPROVED')
    await semear(OUTRO, 'so_do_outro', 'APPROVED')
    const r = (await chamar(T, 'GET', `/v1/templates?status=APPROVED&q=promo&canalId=${CANAL_OFICIAL}`)).json() as { itens: { id: string }[] }
    expect(r.itens.map((i) => i.id)).toEqual([meu])
    expect(await nomesDe('?status=APPROVED', OUTRO)).toEqual(['promo_verao', 'so_do_outro'])
    expect((await chamar(OUTRO, 'GET', `/v1/templates?canalId=${CANAL_OFICIAL}`)).statusCode).toBe(422)
  })

  it('cursor e filtro andam juntos: 55 aprovados em duas páginas, sem repetir nem pular', async () => {
    for (let i = 1; i <= 55; i++) await semearDireto(T, `lote_${String(i).padStart(2, '0')}`, 'APPROVED')
    for (let i = 1; i <= 5; i++) await semearDireto(T, `pend_${i}`, 'PENDING')
    const vistos: string[] = []
    let cursor: string | null = null
    let paginas = 0
    do {
      const qs = `?status=APPROVED${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const j = (await chamar(T, 'GET', `/v1/templates${qs}`)).json() as { itens: { nome: string }[]; proximoCursor: string | null }
      vistos.push(...j.itens.map((i) => i.nome))
      cursor = j.proximoCursor
      paginas++
    } while (cursor)
    expect(paginas).toBe(2)
    expect(new Set(vistos).size).toBe(55)
    expect(vistos.every((n) => n.startsWith('lote_'))).toBe(true)
  })
})
