import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'
import { validarEntradaPeriodo } from './periodo-relatorio.js'
import { taxaDe } from './rotas-relatorios.js'

/**
 * Início v2 e relatórios por dimensão (E1): período inválido, fronteira de mês no fuso do tenant
 * (com o now() do BANCO), isolamento entre tenants, cada dimensão e o limite de grupos.
 */
const T = 'e1e10000-0000-4000-8000-000000000001'
const OUTRO = 'e1e10000-0000-4000-8000-000000000002'
const PV = 'e1e10000-1111-4000-8000-000000000001'
const PV2 = 'e1e10000-1111-4000-8000-000000000002'
const PLANO = 'e1e10000-3333-4000-8000-000000000001'
const MODELO = 'e1e10000-4444-4000-8000-000000000001'
const USU = 'e1e10000-5555-4000-8000-000000000001'
const ORIGEM = 'e1e10000-6666-4000-8000-000000000001'
const ETAPA = 'e1e10000-7777-4000-8000-000000000001'
const c = (n: number): string => `e1e10000-8888-4000-8000-${String(n).padStart(12, '0')}`
const p = (n: number): string => `e1e10000-9999-4000-8000-${String(n).padStart(12, '0')}`

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const chamar = (t: string, url: string) => app.inject({ method: 'GET', url, headers: { 'x-tenant-id': t } })

interface Item { chave: string; rotulo: string; contatos: number; convertidos: number; taxa: number | null; valorCentavos: number }
const itens = async (t: string, dim: string, q = 'inicio=2026-09-01&fim=2026-09-30'): Promise<Item[]> =>
  ((await chamar(t, `/v1/relatorios/contatos-por/${dim}?${q}`)).json() as { itens: Item[] }).itens

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-e1', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-e1', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'A'], [OUTRO, PV2, 'B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id, fuso)
               VALUES (${t}, ${nome}, ${PLANO}, ${pv}, 'America/Sao_Paulo') ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await dono`INSERT INTO usuario (tenant_id, id, nome, email) VALUES (${T}, ${USU}, 'Vera Vendedora', 'vera@e1.test') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO origem (tenant_id, id, nome) VALUES (${T}, ${ORIGEM}, 'Instagram') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO funil_etapa (tenant_id, id, ordem, chave, nome, tipo) VALUES (${T}, ${ETAPA}, 1, 'lead-e1', 'Lead E1', 'aberto') ON CONFLICT DO NOTHING`

  // Setembro/2026 no fuso -03:00:
  //  c1  30/09 23:30 local (= 01/10 02:30Z)  -> setembro; origem Instagram; qualificado; vendedor Vera; UF SP; compra
  //  c2  01/09 00:00 local (= 01/09 03:00Z)  -> setembro (primeiro instante); sem origem; novo
  //  c3  31/08 23:59 local (= 01/09 02:59Z)  -> agosto (fora de setembro); descartado
  //  c4  15/09 12:00 local                   -> setembro; Instagram; novo; etapa Lead E1; sem compra
  const linhas: [number, string, string | null, boolean | null][] = [
    [1, '2026-10-01T02:30:00Z', ORIGEM, true],
    [2, '2026-09-01T03:00:00Z', null, null],
    [3, '2026-09-01T02:59:00Z', null, false],
    [4, '2026-09-15T15:00:00Z', ORIGEM, null],
  ]
  for (const [n, quando, origem, qual] of linhas) {
    await dono`INSERT INTO contato (tenant_id, id, nome, origem_id, qualificado, qualificado_em, criado_em)
               VALUES (${T}, ${c(n)}, ${'Contato ' + n}, ${origem}, ${qual}, ${qual === null ? null : quando}, ${quando})`
  }
  await dono`INSERT INTO carteira_atribuicao (tenant_id, id, contato_id, usuario_id) VALUES (${T}, ${p(900)}, ${c(1)}, ${USU})`
  await dono`INSERT INTO contato_endereco (tenant_id, contato_id, seq, uf, principal, fonte) VALUES (${T}, ${c(1)}, 1, 'SP', true, 'manual')`
  await dono`INSERT INTO oportunidade (tenant_id, id, contato_id, etapa_id) VALUES (${T}, ${p(901)}, ${c(4)}, ${ETAPA})`
  // c1 compra em 20/09 (efetivado), c2 tem pedido só rascunho, c3 (agosto) tem pedido efetivado em setembro.
  await dono`INSERT INTO pedido (tenant_id, id, contato_id, vendedor_id, estado, total_centavos, efetivado_em)
             VALUES (${T}, ${p(1)}, ${c(1)}, ${USU}, 'efetivado', 25000, '2026-09-20T15:00:00Z')`
  await dono`INSERT INTO pedido (tenant_id, id, contato_id, vendedor_id, estado, total_centavos)
             VALUES (${T}, ${p(2)}, ${c(2)}, ${USU}, 'rascunho', 9900)`
  await dono`INSERT INTO pedido (tenant_id, id, contato_id, estado, total_centavos, efetivado_em)
             VALUES (${T}, ${p(3)}, ${c(3)}, 'efetivado', 5000, '2026-09-10T15:00:00Z')`
  // Tarefas: uma atrasada e uma futura.
  await dono`INSERT INTO tarefa (tenant_id, id, contato_id, titulo, vence_em)
             VALUES (${T}, ${p(11)}, ${c(1)}, 'Ligar atrasada', now() - interval '2 days')`
  await dono`INSERT INTO tarefa (tenant_id, id, titulo, vence_em) VALUES (${T}, ${p(12)}, 'Enviar proposta', now() + interval '3 days')`
  // O outro tenant tem um contato em setembro — nunca pode aparecer no T.
  await dono`INSERT INTO contato (tenant_id, id, nome, criado_em) VALUES (${OUTRO}, ${c(50)}, 'Alheio', '2026-09-10T15:00:00Z')`
  app = await criarApp(); await app.ready()
})

afterAll(async () => {
  for (const t of [T, OUTRO]) {
    await dono`DELETE FROM pedido WHERE tenant_id = ${t}`
    await dono`DELETE FROM tarefa WHERE tenant_id = ${t}`
    await dono`DELETE FROM oportunidade WHERE tenant_id = ${t}`
    await dono`DELETE FROM carteira_atribuicao WHERE tenant_id = ${t}`
    await dono`DELETE FROM contato WHERE tenant_id = ${t}`
  }
  await dono`DELETE FROM funil_etapa WHERE tenant_id = ${T}`
  await dono`DELETE FROM origem WHERE tenant_id = ${T}`
  await dono`DELETE FROM usuario WHERE tenant_id = ${T}`
  for (const t of [T, OUTRO]) {
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('regras puras do período', () => {
  it('aceita vazio e período válido; recusa o resto com código tipificado', () => {
    expect(validarEntradaPeriodo(undefined, undefined)).toBeNull()
    expect(validarEntradaPeriodo('2026-09-01', '2026-09-30')).toBeNull()
    expect(validarEntradaPeriodo('2026-09-01', undefined)).toBe('periodo.incompleto')
    expect(validarEntradaPeriodo('2026-02-30', '2026-03-01')).toBe('periodo.invalido')
    expect(validarEntradaPeriodo('01/09/2026', '2026-09-30')).toBe('periodo.invalido')
    expect(validarEntradaPeriodo('2026-09-30', '2026-09-01')).toBe('periodo.invertido')
  })
  it('limite de 366 dias é inclusivo', () => {
    expect(validarEntradaPeriodo('2026-01-01', '2026-12-31')).toBeNull()        // 365 dias
    expect(validarEntradaPeriodo('2024-01-01', '2024-12-31')).toBeNull()        // 366 dias (bissexto)
    expect(validarEntradaPeriodo('2026-01-01', '2027-01-02')).toBe('periodo.longo_demais')
  })
  it('taxa: 4 casas, null sem contatos', () => {
    expect(taxaDe(1, 3)).toBe(0.3333)
    expect(taxaDe(0, 0)).toBeNull()
  })
})

describe('GET /v1/painel/inicio', () => {
  it('período inválido -> 422 tipificado', async () => {
    for (const [q, erro] of [
      ['inicio=2026-09-01', 'periodo.incompleto'],
      ['inicio=abc&fim=2026-09-30', 'periodo.invalido'],
      ['inicio=2026-09-30&fim=2026-09-01', 'periodo.invertido'],
      ['inicio=2025-01-01&fim=2026-09-30', 'periodo.longo_demais'],
    ] as const) {
      const r = await chamar(T, `/v1/painel/inicio?${q}`)
      expect(r.statusCode).toBe(422)
      expect((r.json() as { erro: string }).erro).toBe(erro)
    }
  })

  it('números do período: fronteira de mês no fuso do tenant (30/09 23:30 local é setembro)', async () => {
    const r = (await chamar(T, '/v1/painel/inicio?inicio=2026-09-01&fim=2026-09-30')).json() as {
      periodo: { inicio: string; fim: string; fuso: string }
      contatosNovos: number
      pedidos: { quantidade: number; valorCentavos: number }
      ticketMedioCentavos: number | null
      conversao: { convertidos: number; contatosNovos: number; taxa: number | null }
      tarefas: { pendentes: number; atrasadas: number }
      pedidosPorMes: { mes: string; quantidade: number; valorCentavos: number }[]
      qualificacao: { chave: string; contatos: number }[]
      ranking: { nome: string; pedidos: number; valorCentavos: number }[]
      contatosRecentes: { id: string }[]
      proximasTarefas: { titulo: string }[]
    }
    expect(r.periodo).toEqual({ inicio: '2026-09-01', fim: '2026-09-30', fuso: 'America/Sao_Paulo' })
    expect(r.contatosNovos).toBe(3)                       // c1, c2, c4 (c3 é de agosto)
    expect(r.pedidos).toEqual({ quantidade: 2, valorCentavos: 30000 })  // rascunho não conta
    expect(r.ticketMedioCentavos).toBe(15000)
    expect(r.conversao).toEqual({ convertidos: 1, contatosNovos: 3, taxa: 0.3333 })  // só c1; c3 não é novo
    expect(r.tarefas).toEqual({ pendentes: 2, atrasadas: 1 })
    expect(r.pedidosPorMes).toHaveLength(6)
    expect(r.pedidosPorMes.map((m) => m.mes)).toEqual(['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'])
    expect(r.pedidosPorMes[5]).toEqual({ mes: '2026-09', quantidade: 2, valorCentavos: 30000 })
    expect(r.pedidosPorMes[4]?.quantidade).toBe(0)
    expect(Object.fromEntries(r.qualificacao.map((q) => [q.chave, q.contatos]))).toEqual({ novo: 2, qualificado: 1, descartado: 0 })
    expect(r.ranking[0]).toMatchObject({ nome: 'Vera Vendedora', pedidos: 1, valorCentavos: 25000 })
    expect(r.ranking[1]).toMatchObject({ nome: 'Sem vendedor', valorCentavos: 5000 })
    expect(r.contatosRecentes.length).toBeLessThanOrEqual(10)
    expect(r.proximasTarefas.map((t) => t.titulo)).toEqual(['Ligar atrasada', 'Enviar proposta'])  // atrasada primeiro
  })

  it('outubro começa às 00:00 local: c1 (01/10 02:30Z) fica em setembro e não em outubro', async () => {
    const r = (await chamar(T, '/v1/painel/inicio?inicio=2026-10-01&fim=2026-10-31')).json() as { contatosNovos: number }
    expect(r.contatosNovos).toBe(0)
  })

  it('padrão = mês atual pelo now() do banco no fuso do tenant', async () => {
    // Um contato no primeiro instante do mês local entra; um segundo antes, não.
    await dono`INSERT INTO contato (tenant_id, id, nome, criado_em)
               SELECT ${T}, ${c(60)}, 'Início do mês', (date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')) AT TIME ZONE 'America/Sao_Paulo'`
    await dono`INSERT INTO contato (tenant_id, id, nome, criado_em)
               SELECT ${T}, ${c(61)}, 'Fim do mês passado', (date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')) AT TIME ZONE 'America/Sao_Paulo' - interval '1 second'`
    const [esperado] = await dono<{ inicio: string; fim: string }[]>`
      SELECT to_char(date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM-DD') AS inicio,
             to_char(now() AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS fim`
    const r = (await chamar(T, '/v1/painel/inicio')).json() as { periodo: { inicio: string; fim: string }; contatosNovos: number }
    expect(r.periodo.inicio).toBe(esperado!.inicio)
    expect(r.periodo.fim).toBe(esperado!.fim)
    expect(r.contatosNovos).toBe(1)
  })

  it('isolamento: dois tenants não se enxergam (RLS)', async () => {
    const r = (await chamar(OUTRO, '/v1/painel/inicio?inicio=2026-09-01&fim=2026-09-30')).json() as {
      contatosNovos: number; pedidos: { quantidade: number }; tarefas: { pendentes: number }; ranking: unknown[]
    }
    expect(r.contatosNovos).toBe(1)   // só o 'Alheio'
    expect(r.pedidos.quantidade).toBe(0)
    expect(r.tarefas.pendentes).toBe(0)
    expect(r.ranking).toEqual([])
  })
})

describe('GET /v1/relatorios/contatos-por/:dimensao', () => {
  it('dimensão desconhecida -> 404; período inválido -> 422', async () => {
    expect((await chamar(T, '/v1/relatorios/contatos-por/cor?inicio=2026-09-01&fim=2026-09-30')).statusCode).toBe(404)
    const r = await chamar(T, '/v1/relatorios/contatos-por/origem?inicio=2026-09-30&fim=2026-09-01')
    expect(r.statusCode).toBe(422)
    expect((r.json() as { erro: string }).erro).toBe('periodo.invertido')
  })

  it('origem', async () => {
    const r = await itens(T, 'origem')
    expect(r.find((i) => i.rotulo === 'Instagram')).toMatchObject({ contatos: 2, convertidos: 1, taxa: 0.5, valorCentavos: 25000 })
    expect(r.find((i) => i.chave === 'sem-origem')).toMatchObject({ rotulo: 'Sem origem', contatos: 1, convertidos: 0 })
  })

  it('etapa (atual = oportunidade; sem oportunidade = Sem etapa)', async () => {
    const r = await itens(T, 'etapa')
    expect(r.find((i) => i.chave === 'lead-e1')).toMatchObject({ rotulo: 'Lead E1', contatos: 1 })
    expect(r.find((i) => i.chave === 'sem-etapa')).toMatchObject({ contatos: 2 })
  })

  it('vendedor (carteira atual)', async () => {
    const r = await itens(T, 'vendedor')
    expect(r.find((i) => i.chave === USU)).toMatchObject({ rotulo: 'Vera Vendedora', contatos: 1, convertidos: 1, valorCentavos: 25000 })
    expect(r.find((i) => i.chave === 'sem-vendedor')).toMatchObject({ contatos: 2 })
  })

  it('dia-semana: sempre os 7 dias, no fuso do tenant', async () => {
    const r = await itens(T, 'dia-semana')
    expect(r.map((i) => i.rotulo)).toEqual(['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado', 'Domingo'])
    expect(r.reduce((s, i) => s + i.contatos, 0)).toBe(3)
    // c1: 30/09/2026 23:30 local = quarta (em UTC já seria quinta 01/10); c2: 01/09 = terça; c4: 15/09 = terça.
    expect(r.find((i) => i.chave === '3')?.contatos).toBe(1)
    expect(r.find((i) => i.chave === '2')?.contatos).toBe(2)
    expect(r.find((i) => i.chave === '4')?.contatos).toBe(0)
  })

  it('qualificacao: sempre os 3 estados', async () => {
    const r = await itens(T, 'qualificacao')
    expect(r.map((i) => [i.chave, i.contatos])).toEqual([['novo', 2], ['qualificado', 1], ['descartado', 0]])
  })

  it('uf (endereço principal)', async () => {
    const r = await itens(T, 'uf')
    expect(r.find((i) => i.chave === 'SP')).toMatchObject({ contatos: 1, convertidos: 1 })
    expect(r.find((i) => i.chave === 'sem-uf')).toMatchObject({ rotulo: 'Sem UF', contatos: 2 })
  })

  it('isolamento: o outro tenant só vê o dele', async () => {
    const r = await itens(OUTRO, 'origem')
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ chave: 'sem-origem', contatos: 1 })
  })

  it('limite de 100 grupos: corta e avisa (truncado)', async () => {
    // 105 origens distintas, um contato em cada, no próprio tenant OUTRO.
    await dono`INSERT INTO origem (tenant_id, id, nome)
               SELECT ${OUTRO}, ('e1e10000-6666-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'Origem ' || g FROM generate_series(100, 204) g`
    await dono`INSERT INTO contato (tenant_id, id, nome, origem_id, criado_em)
               SELECT ${OUTRO}, ('e1e10000-8888-4000-8000-' || lpad((g + 1000)::text, 12, '0'))::uuid, 'M' || g,
                      ('e1e10000-6666-4000-8000-' || lpad(g::text, 12, '0'))::uuid, '2026-09-12T15:00:00Z'
                 FROM generate_series(100, 204) g`
    const r = (await chamar(OUTRO, '/v1/relatorios/contatos-por/origem?inicio=2026-09-01&fim=2026-09-30')).json() as { itens: Item[]; truncado: boolean }
    expect(r.itens).toHaveLength(100)
    expect(r.truncado).toBe(true)
    await dono`DELETE FROM contato WHERE tenant_id = ${OUTRO}`
    await dono`DELETE FROM origem WHERE tenant_id = ${OUTRO}`
  })
})
