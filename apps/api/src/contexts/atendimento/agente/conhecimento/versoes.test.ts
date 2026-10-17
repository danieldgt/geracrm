import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import type { FastifyInstance } from 'fastify'
import { criarApp } from '../../../../app.js'
import { comTenantServico, encerrarBanco } from '../../../../db/index.js'
import { EmbeddingIndisponivel } from '../../../catalogo/porta-embedding.js'
import type { ContextoFerramenta } from '../ferramentas/porta.js'
import { criarConhecimentoReal } from './conhecimento-real.js'
import { registrarVersao, type SnapshotDocumento } from './versoes.js'

/**
 * HISTÓRICO IMUTÁVEL DO CONHECIMENTO (raia P9, migration 0100).
 *
 * Cenários: a versão nasce na transação da escrita; restaurar cria versão nova
 * sem reescrever o passado; histórico por cursor; "Título vN" citado pelo
 * agente abre o texto EXATO da vN; versão anterior ao histórico é falha
 * nomeada; dois tenants não se enxergam (RLS, papel geracrm_api).
 *
 * ⚠️ UUIDs exclusivos deste arquivo (prefixo c0b9).
 */
const T = 'c0b90000-0000-4000-8000-000000000001'
const OUTRO = 'c0b90000-0000-4000-8000-000000000002'
const PV = 'c0b90000-1111-4000-8000-000000000001'
const PV2 = 'c0b90000-1111-4000-8000-000000000002'
const PLANO = 'c0b90000-3333-4000-8000-000000000001'
const MODELO = 'c0b90000-4444-4000-8000-000000000001'
const CANAL = 'c0b90000-7777-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const chamar = (t: string, m: 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE', url: string, corpo?: Record<string, unknown>) =>
  app.inject({ method: m, url, headers: { 'x-tenant-id': t }, ...(corpo ? { payload: corpo } : {}) })

type Doc = { id: string; versao: number; titulo: string; conteudo: string; publicado: boolean; tipo: string; canalId: string | null }
type Item = { versao: number; titulo: string; origem: string; restauradaDe: number | null; observacao: string | null; atual: boolean; caracteres: number; autor: { id: string } | null }
type Pagina = { versaoAtual: number; itens: Item[]; proximoCursor: string | null }
type Versao = Item & { documentoId: string; conteudo: string; versaoAtual: number }

async function criar(t: string, titulo: string, conteudo: string, extra: Record<string, unknown> = {}): Promise<Doc> {
  const r = await chamar(t, 'POST', '/v1/agente/conhecimento', { titulo, tipo: 'faq', conteudo, ...extra })
  expect(r.statusCode).toBe(201)
  return r.json() as Doc
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-conhecimento-versoes', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-conhecimento-versoes', 'Varejo') ON CONFLICT DO NOTHING`
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
  await dono`DELETE FROM usuario WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM tenant WHERE id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('A versão nasce na mesma transação da escrita', () => {
  it('POST cria a v1 no histórico, com autor, origem criacao e auditoria', async () => {
    const d = await criar(T, 'Prazos', 'Entregamos em 5 dias úteis.')
    const [v] = await dono<{ versao: number; origem: string; conteudo: string; autor_id: string | null }[]>`
      SELECT versao, origem, conteudo, autor_id FROM conhecimento_documento_versao WHERE tenant_id = ${T} AND documento_id = ${d.id}`
    expect(v).toMatchObject({ versao: 1, origem: 'criacao', conteudo: 'Entregamos em 5 dias úteis.' })
    expect(v!.autor_id).not.toBeNull()
    const [a] = await dono<{ n: number }[]>`
      SELECT count(*)::int AS n FROM auditoria WHERE tenant_id = ${T} AND acao = 'conhecimento.criado' AND entidade_id = ${d.id}`
    expect(a!.n).toBe(1)
  })

  it('PATCH de conteúdo grava a v2 com o texto novo e a observação; a v1 continua com o texto antigo', async () => {
    const d = await criar(T, 'Pagamento', 'PIX e boleto.')
    const r = await chamar(T, 'PATCH', `/v1/agente/conhecimento/${d.id}`, { conteudo: 'PIX, boleto e cartão.', observacao: 'cartão liberado' })
    expect(r.json()).toMatchObject({ versao: 2 })
    const vs = await dono<{ versao: number; origem: string; conteudo: string; observacao: string | null }[]>`
      SELECT versao, origem, conteudo, observacao FROM conhecimento_documento_versao
       WHERE tenant_id = ${T} AND documento_id = ${d.id} ORDER BY versao`
    expect(vs).toEqual([
      { versao: 1, origem: 'criacao', conteudo: 'PIX e boleto.', observacao: null },
      { versao: 2, origem: 'edicao', conteudo: 'PIX, boleto e cartão.', observacao: 'cartão liberado' },
    ])
    const [a] = await dono<{ dados: { campos: string[]; versao: number; versaoAnterior: number } }[]>`
      SELECT dados FROM auditoria WHERE tenant_id = ${T} AND acao = 'conhecimento.editado' AND entidade_id = ${d.id}`
    expect(a!.dados).toMatchObject({ campos: ['conteudo'], versao: 2, versaoAnterior: 1 })
  })

  it('PATCH só de publicado não cria versão (mas é auditado)', async () => {
    const d = await criar(T, 'Troca', 'Troca em 7 dias.')
    await chamar(T, 'PATCH', `/v1/agente/conhecimento/${d.id}`, { publicado: false })
    const [n] = await dono<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conhecimento_documento_versao WHERE tenant_id = ${T} AND documento_id = ${d.id}`
    expect(n!.n).toBe(1)
    const [a] = await dono<{ dados: { campos: string[] } }[]>`
      SELECT dados FROM auditoria WHERE tenant_id = ${T} AND acao = 'conhecimento.editado' AND entidade_id = ${d.id}`
    expect(a!.dados.campos).toEqual(['publicado'])
  })

  it('transação que falha depois de gravar a versão não deixa nem documento nem versão (atômico)', async () => {
    const d = await criar(T, 'Atômico', 'texto 1')
    await expect(comTenantServico(T, async (tx) => {
      const [snap] = await tx<SnapshotDocumento[]>`
        UPDATE conhecimento_documento SET conteudo = 'texto 2', versao = versao + 1
         WHERE tenant_id = tenant_atual() AND id = ${d.id} RETURNING id, versao, titulo, tipo, canal_id, conteudo`
      await registrarVersao(tx, snap!, { origem: 'edicao' })
      throw new Error('falha depois de gravar')
    })).rejects.toThrow('falha depois de gravar')
    const [doc] = await dono<{ versao: number }[]>`SELECT versao FROM conhecimento_documento WHERE tenant_id = ${T} AND id = ${d.id}`
    const [n] = await dono<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conhecimento_documento_versao WHERE tenant_id = ${T} AND documento_id = ${d.id}`
    expect(doc!.versao).toBe(1)
    expect(n!.n).toBe(1)
  })

  it('escritor que não registra (a API anterior, no meio do deploy) ganha a versão "automatica" pelo trigger no commit', async () => {
    const d = await criar(T, 'Legado', 'antes')
    await comTenantServico(T, (tx) => tx`
      UPDATE conhecimento_documento SET conteudo = 'depois', versao = versao + 1, atualizado_em = now()
       WHERE tenant_id = tenant_atual() AND id = ${d.id}`)
    const [v] = await dono<{ origem: string; conteudo: string }[]>`
      SELECT origem, conteudo FROM conhecimento_documento_versao WHERE tenant_id = ${T} AND documento_id = ${d.id} AND versao = 2`
    expect(v).toEqual({ origem: 'automatica', conteudo: 'depois' })
  })

  it('o histórico é imutável: UPDATE é recusado até para o dono do banco', async () => {
    const d = await criar(T, 'Imutável', 'original')
    await expect(dono`UPDATE conhecimento_documento_versao SET conteudo = 'adulterado'
                       WHERE tenant_id = ${T} AND documento_id = ${d.id}`).rejects.toThrow(/imutável/)
    await expect(comTenantServico(T, (tx) => tx`UPDATE conhecimento_documento_versao SET conteudo = 'adulterado'
                       WHERE tenant_id = tenant_atual() AND documento_id = ${d.id}`)).rejects.toThrow()
  })
})

describe('Histórico por cursor', () => {
  let doc: Doc
  beforeAll(async () => {
    doc = await criar(T, 'Muitas versões', 'v1')
    for (let i = 2; i <= 25; i++) await chamar(T, 'PATCH', `/v1/agente/conhecimento/${doc.id}`, { conteudo: `v${i}` })
  })

  it('primeira página: 20 versões, da mais nova para a mais velha, a atual marcada', async () => {
    const r = await chamar(T, 'GET', `/v1/agente/conhecimento/${doc.id}/versoes`)
    expect(r.statusCode).toBe(200)
    const p = r.json() as Pagina
    expect(p.versaoAtual).toBe(25)
    expect(p.itens).toHaveLength(20)
    expect(p.itens.map((i) => i.versao)).toEqual(Array.from({ length: 20 }, (_, k) => 25 - k))
    expect(p.itens[0]!.atual).toBe(true)
    expect(p.itens.slice(1).every((i) => !i.atual)).toBe(true)
    expect(p.proximoCursor).toBe('6')
  })

  it('segunda página pelo cursor fecha o histórico sem repetir nem pular', async () => {
    const p = (await chamar(T, 'GET', `/v1/agente/conhecimento/${doc.id}/versoes?cursor=6`)).json() as Pagina
    expect(p.itens.map((i) => i.versao)).toEqual([5, 4, 3, 2, 1])
    expect(p.proximoCursor).toBeNull()
  })

  it('cursor inválido → 422; documento desconhecido → 404', async () => {
    expect((await chamar(T, 'GET', `/v1/agente/conhecimento/${doc.id}/versoes?cursor=abc`)).statusCode).toBe(422)
    expect((await chamar(T, 'GET', `/v1/agente/conhecimento/${randomUUID()}/versoes`)).statusCode).toBe(404)
  })
})

describe('Ler uma versão: o texto exato', () => {
  it('a v1 devolve o texto da v1 mesmo depois de editada', async () => {
    const d = await criar(T, 'Frete', 'Frete grátis acima de R$ 300.')
    await chamar(T, 'PATCH', `/v1/agente/conhecimento/${d.id}`, { conteudo: 'Frete grátis acima de R$ 250.' })
    const r = await chamar(T, 'GET', `/v1/agente/conhecimento/${d.id}/versoes/1`)
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ documentoId: d.id, versao: 1, conteudo: 'Frete grátis acima de R$ 300.', atual: false, versaoAtual: 2 })
  })

  it('versão que não existe → 404 conhecimento.versao_nao_encontrada', async () => {
    const d = await criar(T, 'Só uma', 'texto')
    const r = await chamar(T, 'GET', `/v1/agente/conhecimento/${d.id}/versoes/9`)
    expect(r.statusCode).toBe(404)
    expect(r.json()).toMatchObject({ erro: 'conhecimento.versao_nao_encontrada' })
  })

  it('versão sobrescrita antes do histórico (backfill só tem a vigente) → falha nomeada, nunca o texto de outra', async () => {
    const id = randomUUID()
    // Documento de antes da 0100: estava na v4 e só a v4 entrou no backfill.
    // (O trigger grava a v4 como 'automatica'; trocamos pela linha do backfill.)
    await dono`INSERT INTO conhecimento_documento (tenant_id, id, titulo, tipo, conteudo, versao)
               VALUES (${T}, ${id}, 'Antigo', 'faq', 'texto da v4', 4)`
    await dono`DELETE FROM conhecimento_documento_versao WHERE tenant_id = ${T} AND documento_id = ${id}`
    await dono`INSERT INTO conhecimento_documento_versao (tenant_id, documento_id, versao, titulo, tipo, conteudo, origem)
               VALUES (${T}, ${id}, 4, 'Antigo', 'faq', 'texto da v4', 'backfill')`
    const r = await chamar(T, 'GET', `/v1/agente/conhecimento/${id}/versoes/2`)
    expect(r.statusCode).toBe(404)
    expect(r.json()).toMatchObject({ erro: 'conhecimento.versao_anterior_ao_historico', primeiraRegistrada: 4 })
    expect((await chamar(T, 'GET', `/v1/agente/conhecimento/${id}/versoes/4`)).json()).toMatchObject({ conteudo: 'texto da v4', origem: 'backfill' })
  })
})

describe('Restaurar cria versão nova', () => {
  it('restaurar a v1 vira v3 com o texto da v1; v1 e v2 ficam intactas; auditado', async () => {
    const d = await criar(T, 'Política de troca', 'Troca em 7 dias.')
    await chamar(T, 'PATCH', `/v1/agente/conhecimento/${d.id}`, { conteudo: 'Troca em 30 dias.' })
    const r = await chamar(T, 'POST', `/v1/agente/conhecimento/${d.id}/restaurar`, { versao: 1, observacao: 'voltou a regra antiga' })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ versao: 3, conteudo: 'Troca em 7 dias.', restauradaDe: 1 })

    const p = (await chamar(T, 'GET', `/v1/agente/conhecimento/${d.id}/versoes`)).json() as Pagina
    expect(p.itens.map((i) => [i.versao, i.origem, i.restauradaDe])).toEqual([[3, 'restauracao', 1], [2, 'edicao', null], [1, 'criacao', null]])
    expect(p.itens[0]!.observacao).toBe('voltou a regra antiga')
    expect((await chamar(T, 'GET', `/v1/agente/conhecimento/${d.id}/versoes/2`)).json()).toMatchObject({ conteudo: 'Troca em 30 dias.' })

    const [a] = await dono<{ dados: { restauradaDe: number; versao: number } }[]>`
      SELECT dados FROM auditoria WHERE tenant_id = ${T} AND acao = 'conhecimento.restaurado' AND entidade_id = ${d.id}`
    expect(a!.dados).toMatchObject({ restauradaDe: 1, versao: 3, versaoAnterior: 2 })
    // O retrieval passa a ler o texto restaurado.
    const [t] = await dono<{ texto: string }[]>`
      SELECT texto FROM conhecimento_trecho WHERE tenant_id = ${T} AND documento_id = ${d.id} ORDER BY ordem LIMIT 1`
    expect(t!.texto).toContain('Troca em 7 dias.')
  })

  it('restaurar uma versão igual à atual → 422 conhecimento.restaurar_sem_mudanca, nada muda', async () => {
    const d = await criar(T, 'Igual', 'mesmo texto')
    const r = await chamar(T, 'POST', `/v1/agente/conhecimento/${d.id}/restaurar`, { versao: 1 })
    expect(r.statusCode).toBe(422)
    expect(r.json()).toMatchObject({ erro: 'conhecimento.restaurar_sem_mudanca', campos: ['versao'] })
  })

  it('versão inexistente → 422 apontando versao; corpo inválido → 422 campo_invalido', async () => {
    const d = await criar(T, 'Sem v7', 'x')
    expect((await chamar(T, 'POST', `/v1/agente/conhecimento/${d.id}/restaurar`, { versao: 7 })).json())
      .toMatchObject({ erro: 'conhecimento.versao_nao_encontrada', campos: ['versao'] })
    expect((await chamar(T, 'POST', `/v1/agente/conhecimento/${d.id}/restaurar`, { versao: 0 })).json())
      .toMatchObject({ erro: 'conhecimento.campo_invalido', campos: ['versao'] })
  })

  it('restaurar o espelho das políticas escreve de volta em agente_config.politicas', async () => {
    await chamar(T, 'PUT', `/v1/canais/${CANAL}/agente`, { modo: 'sombra', politicas: 'Pedido mínimo R$ 500.' })
    await chamar(T, 'PUT', `/v1/canais/${CANAL}/agente`, { modo: 'sombra', politicas: 'Pedido mínimo R$ 800.' })
    const [pol] = await dono<{ id: string; versao: number }[]>`
      SELECT id, versao FROM conhecimento_documento WHERE tenant_id = ${T} AND canal_id = ${CANAL} AND tipo = 'politicas'`
    expect(pol!.versao).toBe(2)
    const origens = await dono<{ origem: string }[]>`
      SELECT origem FROM conhecimento_documento_versao WHERE tenant_id = ${T} AND documento_id = ${pol!.id} ORDER BY versao`
    expect(origens.map((o) => o.origem)).toEqual(['sincronismo', 'sincronismo'])

    const r = await chamar(T, 'POST', `/v1/agente/conhecimento/${pol!.id}/restaurar`, { versao: 1 })
    expect(r.json()).toMatchObject({ versao: 3, conteudo: 'Pedido mínimo R$ 500.' })
    const cfg = (await chamar(T, 'GET', `/v1/canais/${CANAL}/agente`)).json() as { politicas: string }
    expect(cfg.politicas).toBe('Pedido mínimo R$ 500.')
  })
})

describe('"Título vN" citado pelo agente abre o texto exato daquela versão', () => {
  const ctx: ContextoFerramenta = {
    tenantId: T, conversaId: randomUUID(), contatoId: randomUUID(), canalId: CANAL,
    perfil: 'varejo', sessaoId: null, modo: 'sombra', agora: new Date(),
  }

  it('a busca do vendedor devolve citacoes {documentoId, versao}; depois de editar, a citação ainda abre o texto lido', async () => {
    const d = await criar(T, 'Atacado', 'No atacado a grade mínima é de 12 peças por modelo.')
    const kb = criarConhecimentoReal({ embedding: EmbeddingIndisponivel })
    const r = await kb.buscar(ctx, 'qual a grade mínima do atacado?') as {
      citacoes: { documentoId: string; versao: number; titulo: string }[]; trechos: { texto: string; fonte: string }[]
    }
    const c = r.citacoes.find((x) => x.documentoId === d.id)!
    expect(c).toEqual({ documentoId: d.id, versao: 1, titulo: 'Atacado' })
    expect(r.trechos.some((t) => t.fonte === 'Atacado v1')).toBe(true)
    // A citação vem antes dos trechos: sobrevive ao corte de 4.000 caracteres da saída gravada.
    expect(Object.keys(r)[0]).toBe('citacoes')

    await chamar(T, 'PATCH', `/v1/agente/conhecimento/${d.id}`, { conteudo: 'No atacado a grade mínima é de 6 peças.' })
    const v = (await chamar(T, 'GET', `/v1/agente/conhecimento/${c.documentoId}/versoes/${c.versao}`)).json() as Versao
    const lido = r.trechos.find((t) => t.fonte === 'Atacado v1')!.texto
    expect(lido).toContain(v.conteudo)
    expect(v.conteudo).toBe('No atacado a grade mínima é de 12 peças por modelo.')
  })
})

describe('RLS: dois tenants', () => {
  it('o outro tenant não lista, não lê e não restaura versões do primeiro', async () => {
    const d = await criar(T, 'Segredo do A', 'texto do A')
    await chamar(T, 'PATCH', `/v1/agente/conhecimento/${d.id}`, { conteudo: 'texto do A, v2' })
    expect((await chamar(OUTRO, 'GET', `/v1/agente/conhecimento/${d.id}/versoes`)).statusCode).toBe(404)
    expect((await chamar(OUTRO, 'GET', `/v1/agente/conhecimento/${d.id}/versoes/1`)).statusCode).toBe(404)
    const r = await chamar(OUTRO, 'POST', `/v1/agente/conhecimento/${d.id}/restaurar`, { versao: 1 })
    expect(r.statusCode).toBe(404)
    const [doc] = await dono<{ versao: number }[]>`SELECT versao FROM conhecimento_documento WHERE tenant_id = ${T} AND id = ${d.id}`
    expect(doc!.versao).toBe(2)
  })

  it('sob o papel da aplicação, a tabela de versões só devolve linhas do tenant da transação', async () => {
    const d = await criar(T, 'Só do A', 'x')
    const doOutro = await comTenantServico(OUTRO, (tx) => tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conhecimento_documento_versao WHERE documento_id = ${d.id}`)
    expect(doOutro[0]!.n).toBe(0)
    const doDono = await comTenantServico(T, (tx) => tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conhecimento_documento_versao WHERE documento_id = ${d.id}`)
    expect(doDono[0]!.n).toBe(1)
    // Inserir versão em nome de outro tenant é barrado pela policy (WITH CHECK).
    await expect(comTenantServico(OUTRO, (tx) => tx`
      INSERT INTO conhecimento_documento_versao (tenant_id, documento_id, versao, titulo, tipo, conteudo, origem)
      VALUES (${T}, ${d.id}, 99, 'x', 'faq', 'x', 'edicao')`)).rejects.toThrow()
  })
})
