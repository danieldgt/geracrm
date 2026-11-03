import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'

/**
 * EP-07 — leitura do rastro de auditoria com paginação por CURSOR.
 *
 * ⚠️ O invariante do CLAUDE.md: lista sempre por cursor, nunca top-N cru. Os
 * riscos que o teste fecha:
 *   • a paginação não pode PERDER nem DUPLICAR linha entre páginas;
 *   • a última página zera `proximoCursor` (senão a tela pagina para sempre);
 *   • um tenant nunca lê o rastro de outro (RLS).
 */
const T = 'aad17000-0000-4000-8000-000000000001'
const OUTRO = 'aad17000-0000-4000-8000-000000000002'
const PV = 'aad17000-1111-4000-8000-000000000001'
const PV2 = 'aad17000-1111-4000-8000-000000000002'
const PLANO = 'aad17000-3333-4000-8000-000000000001'
const MODELO = 'aad17000-4444-4000-8000-000000000001'
const ATOR = 'aad17000-8888-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance

const chamar = (tenant: string, url: string) =>
  app.inject({ method: 'GET', url, headers: { 'x-tenant-id': tenant } })

// ⚠️ Início do MÊS CORRENTE: as partições da auditoria vão de `now()` a +12
//    meses (migration 0004). Uma data fixa no passado não tem partição — e o
//    INSERT falharia. 120 min a partir do dia 1º cabem no mês, sempre.
const agora = new Date()
const INICIO_MES = Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), 1)

/** Insere N entradas com `criado_em` crescente e determinístico. */
async function semear(tenant: string, n: number, base = INICIO_MES): Promise<void> {
  for (let i = 0; i < n; i++) {
    const quando = new Date(base + i * 60_000).toISOString()
    await dono`
      INSERT INTO auditoria (tenant_id, id, criado_em, ator_id, acao, entidade, entidade_id, dados)
      VALUES (${tenant}, ${randomUUID()}, ${quando}, ${ATOR}, 'atendimento.assumido', 'conversa',
              ${randomUUID()}, ${JSON.stringify({ protocolo: i })}::text::jsonb)`
  }
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-audit', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-audit', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'Loja A'], [OUTRO, PV2, 'Loja B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${T}, ${ATOR}, 'sub-audit', 'Ana', 'ana@t.local') ON CONFLICT (tenant_id, cognito_sub) DO NOTHING`
  app = await criarApp()
  await app.ready()
})

afterAll(async () => {
  for (const t of [T, OUTRO]) {
    await dono`DELETE FROM auditoria WHERE tenant_id = ${t}`
    await dono`DELETE FROM usuario WHERE tenant_id = ${t}`
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close()
  await encerrarBanco()
  await dono.end()
})

describe('EP-07: /v1/auditoria por cursor', () => {
  it('pagina 120 linhas sem perder nem duplicar, e a última página zera o cursor', async () => {
    await dono`DELETE FROM auditoria WHERE tenant_id = ${T}`
    await semear(T, 120) // 50 + 50 + 20 → 3 páginas (PAGINA = 50)

    const vistos: string[] = []
    let cursor: string | null = null
    let paginas = 0
    do {
      const url: string = cursor ? `/v1/auditoria?cursor=${encodeURIComponent(cursor)}` : '/v1/auditoria'
      const r = await chamar(T, url)
      expect(r.statusCode).toBe(200)
      const corpo = r.json() as { itens: { entidadeId: string }[]; proximoCursor: string | null }
      // Mais novo primeiro: dentro da página, criado_em decrescente.
      for (const it of corpo.itens) vistos.push(it.entidadeId)
      cursor = corpo.proximoCursor
      paginas++
      expect(paginas).toBeLessThanOrEqual(5) // trava de laço infinito
    } while (cursor)

    expect(paginas).toBe(3)
    expect(vistos.length).toBe(120)
    // Sem duplicar: todos os entidadeId são únicos.
    expect(new Set(vistos).size).toBe(120)
  })

  it('cursor inválido responde 422, não 500', async () => {
    const r = await chamar(T, '/v1/auditoria?cursor=lixo')
    expect(r.statusCode).toBe(422)
  })

  it('⚠️ isolamento: o rastro de um tenant nunca aparece para outro (RLS)', async () => {
    await dono`DELETE FROM auditoria WHERE tenant_id IN (${T}, ${OUTRO})`
    await semear(OUTRO, 3)
    const r = await chamar(T, '/v1/auditoria')
    const corpo = r.json() as { itens: unknown[] }
    expect(corpo.itens.length).toBe(0)
  })
})

// ───────────────────────── Filtros, detalhe e precisão (D6) ─────────────────────────

interface Semente {
  quando: string; acao?: string; entidade?: string; entidadeId?: string
  ator?: string | null; dados?: Record<string, unknown>
}
interface ItemAuditoria {
  id: string; criadoEm: string; acao: string; entidade: string; entidadeId: string | null
  atorNome: string | null; dados: unknown
}

const MES = new Date(INICIO_MES).toISOString().slice(0, 8) // 'AAAA-MM-'
/** Instante no mês corrente. `micro` entra como fração (6 dígitos) — a precisão do banco. */
const quando = (dia: number, hora = '10:00:00', micro = '000000'): string =>
  `${MES}${String(dia).padStart(2, '0')}T${hora}.${micro}Z`

async function limparRastro(): Promise<void> {
  await dono`DELETE FROM auditoria WHERE tenant_id IN (${T}, ${OUTRO})`
}

async function inserir(tenant: string, linhas: Semente[]): Promise<void> {
  for (const r of linhas) {
    const ator = r.ator === undefined ? ATOR : r.ator
    await dono`
      INSERT INTO auditoria (tenant_id, id, criado_em, ator_id, acao, entidade, entidade_id, dados)
      VALUES (${tenant}, ${randomUUID()}, ${r.quando}::text::timestamptz, ${ator}, ${r.acao ?? 'atendimento.assumido'},
              ${r.entidade ?? 'conversa'}, ${r.entidadeId ?? randomUUID()}, ${JSON.stringify(r.dados ?? {})}::text::jsonb)`
  }
}

/** Segue o cursor até o fim e devolve todas as linhas, na ordem que a API entregou. */
async function todasAsPaginas(tenant: string, parametros: Record<string, string> = {}): Promise<ItemAuditoria[]> {
  const itens: ItemAuditoria[] = []
  let cursor: string | null = null
  let paginas = 0
  do {
    const qs = new URLSearchParams(parametros)
    if (cursor) qs.set('cursor', cursor)
    const r = await chamar(tenant, `/v1/auditoria?${qs.toString()}`)
    expect(r.statusCode).toBe(200)
    const corpo = r.json() as { itens: ItemAuditoria[]; proximoCursor: string | null }
    itens.push(...corpo.itens)
    cursor = corpo.proximoCursor
    paginas++
    expect(paginas).toBeLessThanOrEqual(10) // trava de laço infinito
  } while (cursor)
  return itens
}

describe('D6: filtros de /v1/auditoria', () => {
  it('acao aceita uma ação ou uma lista separada por vírgula', async () => {
    await limparRastro()
    await inserir(T, [
      { quando: quando(1), acao: 'atendimento.assumido' },
      { quando: quando(2), acao: 'mensagem.apagada' },
      { quando: quando(3), acao: 'mensagem.editada' },
    ])
    const so = await todasAsPaginas(T, { acao: 'mensagem.apagada' })
    expect(so.map((i) => i.acao)).toEqual(['mensagem.apagada'])
    const duas = await todasAsPaginas(T, { acao: 'mensagem.apagada, mensagem.editada' })
    expect(duas.map((i) => i.acao).sort()).toEqual(['mensagem.apagada', 'mensagem.editada'])
  })

  it('entidade e entidadeId filtram só o que bate', async () => {
    await limparRastro()
    const alvo = randomUUID()
    await inserir(T, [
      { quando: quando(1), entidade: 'conversa', entidadeId: alvo },
      { quando: quando(2), entidade: 'mensagem', entidadeId: alvo },
      { quando: quando(3), entidade: 'conversa' },
    ])
    expect((await todasAsPaginas(T, { entidade: 'conversa' })).length).toBe(2)
    const porId = await todasAsPaginas(T, { entidadeId: alvo })
    expect(porId.length).toBe(2)
    expect(await todasAsPaginas(T, { entidade: 'mensagem', entidadeId: alvo })).toHaveLength(1)
  })

  it('atorId separa as ações de um usuário das do sistema (ator NULL)', async () => {
    await limparRastro()
    await inserir(T, [
      { quando: quando(1), ator: ATOR },
      { quando: quando(2), ator: ATOR },
      { quando: quando(3), ator: null },
    ])
    const deAna = await todasAsPaginas(T, { atorId: ATOR })
    expect(deAna.length).toBe(2)
    expect(deAna.every((i) => i.atorNome === 'Ana')).toBe(true)
    // Ação do sistema não tem ator: aparece sem o filtro, nunca dentro de um usuário.
    expect((await todasAsPaginas(T)).length).toBe(3)
  })

  it('de é inclusivo e ate é exclusivo, em ISO com fuso', async () => {
    await limparRastro()
    await inserir(T, [
      { quando: quando(3, '00:00:00') },
      { quando: quando(5, '12:00:00') },
      { quando: quando(8, '00:00:00') },
    ])
    const r = await todasAsPaginas(T, { de: quando(3, '00:00:00'), ate: quando(8, '00:00:00') })
    // Mais novo primeiro. O dia 3 à 00h00 entra (de inclusivo); o dia 8 à 00h00 fica FORA (ate exclusivo).
    expect(r.map((i) => i.criadoEm.slice(0, 10))).toEqual([`${MES}05`, `${MES}03`])
  })

  it('q busca em ação e no detalhe (dados), sem ser fooled por % e _', async () => {
    await limparRastro()
    await inserir(T, [
      { quando: quando(1), dados: { obs: 'cliente pediu urgente' } },
      { quando: quando(2), dados: { obs: '100% ok' } },
      { quando: quando(3), dados: { obs: 'abc' } },
    ])
    const urgente = await todasAsPaginas(T, { q: 'URGENTE' })
    expect(urgente.length).toBe(1)
    // Sem escape, '%' vira curinga e casaria tudo; com escape, só o registro que tem '%' literal.
    expect((await todasAsPaginas(T, { q: '%' })).length).toBe(1)
    expect((await todasAsPaginas(T, { q: '_' })).length).toBe(0)
    expect((await todasAsPaginas(T, { q: 'assumido' })).length).toBe(3)
  })

  it('combina filtros com AND (acao + usuário + período)', async () => {
    await limparRastro()
    await inserir(T, [
      { quando: quando(2), acao: 'mensagem.apagada', ator: ATOR },
      { quando: quando(2), acao: 'mensagem.apagada', ator: null },
      { quando: quando(2), acao: 'atendimento.assumido', ator: ATOR },
      { quando: quando(9), acao: 'mensagem.apagada', ator: ATOR },
    ])
    const r = await todasAsPaginas(T, {
      acao: 'mensagem.apagada', atorId: ATOR, de: quando(1, '00:00:00'), ate: quando(5, '00:00:00'),
    })
    expect(r.length).toBe(1)
    expect(r[0]?.acao).toBe('mensagem.apagada')
  })

  it('⚠️ cursor com filtro: pagina 120 linhas filtradas sem perder nem trazer as de fora', async () => {
    await limparRastro()
    const seed: Semente[] = []
    for (let i = 0; i < 120; i++) seed.push({ quando: quando(4, '10:00:00', String(i + 1).padStart(6, '0')), acao: 'mensagem.editada' })
    for (let i = 0; i < 30; i++) seed.push({ quando: quando(4, '11:00:00', String(i + 1).padStart(6, '0')), acao: 'mensagem.apagada' })
    await inserir(T, seed)

    const vistos = await todasAsPaginas(T, { acao: 'mensagem.editada' })
    expect(vistos.length).toBe(120)
    expect(new Set(vistos.map((i) => i.id)).size).toBe(120)
    expect(vistos.every((i) => i.acao === 'mensagem.editada')).toBe(true)
  })

  it('⚠️ precisão: linhas no MESMO milissegundo não se perdem entre páginas', async () => {
    // Antes, o cursor saía em milissegundos: todas as linhas do ms .000 com fração
    // maior que zero caíam fora da página seguinte.
    await limparRastro()
    const seed: Semente[] = []
    for (let i = 0; i < 120; i++) seed.push({ quando: quando(6, '09:00:00', String(i + 1).padStart(6, '0')) })
    await inserir(T, seed)
    const vistos = await todasAsPaginas(T)
    expect(new Set(vistos.map((i) => i.id)).size).toBe(120)
  })

  it('filtro inválido responde 422 tipificado, nunca 500 nem filtro ignorado', async () => {
    const casos: [string, string][] = [
      ['de=ontem', 'de'],
      ['ate=2026-13-45T00:00:00Z', 'ate'],
      ['atorId=nao-e-uuid', 'atorId'],
      ['acao=mensagem.apagada;drop', 'acao'],
      ['acao=' + Array.from({ length: 21 }, (_, i) => `a${i}`).join(','), 'acao'],
      ['entidade=' + encodeURIComponent('x y'), 'entidade'],
      ['q=' + 'x'.repeat(81), 'q'],
      ['acao=a&acao=b', 'acao'],
    ]
    for (const [qs, campo] of casos) {
      const r = await chamar(T, `/v1/auditoria?${qs}`)
      expect(r.statusCode, qs).toBe(422)
      const corpo = r.json() as { erro: string; campos: string[] }
      expect(corpo.erro).toMatch(/^auditoria\./)
      expect(corpo.campos, qs).toContain(campo)
    }
  })

  it('período com início depois do fim responde 422 (de e ate juntos)', async () => {
    const r = await chamar(T, `/v1/auditoria?de=${encodeURIComponent(quando(9))}&ate=${encodeURIComponent(quando(2))}`)
    expect(r.statusCode).toBe(422)
    expect((r.json() as { erro: string }).erro).toBe('auditoria.periodo_invalido')
  })

  it('⚠️ dois tenants: filtros nunca trazem o rastro do outro, nem com a mesma ação', async () => {
    await limparRastro()
    await inserir(OUTRO, [{ quando: quando(2), acao: 'mensagem.apagada' }])
    await inserir(T, [{ quando: quando(2), acao: 'atendimento.assumido' }])
    expect(await todasAsPaginas(T, { acao: 'mensagem.apagada' })).toHaveLength(0)
    expect(await todasAsPaginas(OUTRO, { acao: 'mensagem.apagada' })).toHaveLength(1)
  })
})

describe('D6: detalhe de um evento', () => {
  it('GET /v1/auditoria/:criadoEm/:id devolve o JSON completo; a chave da lista funciona', async () => {
    await limparRastro()
    await inserir(T, [{ quando: quando(7, '08:30:00', '123456'), dados: { antes: { a: 1 }, depois: { a: 2 } } }])
    const [item] = await todasAsPaginas(T)
    expect(item).toBeDefined()
    // Precisão de microssegundo preservada: a chave da lista é a chave do detalhe.
    expect(item!.criadoEm).toMatch(/\.123456Z$/)
    const r = await chamar(T, `/v1/auditoria/${encodeURIComponent(item!.criadoEm)}/${item!.id}`)
    expect(r.statusCode).toBe(200)
    expect((r.json() as ItemAuditoria).dados).toEqual({ antes: { a: 1 }, depois: { a: 2 } })
  })

  it('⚠️ evento de outro tenant não resolve: 404, nunca o conteúdo', async () => {
    await limparRastro()
    await inserir(OUTRO, [{ quando: quando(7, '08:30:00', '654321'), dados: { segredo: true } }])
    const [deOutro] = await todasAsPaginas(OUTRO)
    const r = await chamar(T, `/v1/auditoria/${encodeURIComponent(deOutro!.criadoEm)}/${deOutro!.id}`)
    expect(r.statusCode).toBe(404)
    expect(r.body).not.toContain('segredo')
  })

  it('chave malformada responde 422 e chave inexistente 404', async () => {
    const ruim = await chamar(T, `/v1/auditoria/nao-e-data/${randomUUID()}`)
    expect(ruim.statusCode).toBe(422)
    const ausente = await chamar(T, `/v1/auditoria/${encodeURIComponent(quando(1))}/${randomUUID()}`)
    expect(ausente.statusCode).toBe(404)
  })
})
