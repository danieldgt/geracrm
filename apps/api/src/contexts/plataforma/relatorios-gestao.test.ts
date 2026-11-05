import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { encerrarBanco } from '../../db/index.js'
import { pluginTenant } from '../../plugins/tenant.js'
import { rotasRelatoriosGestao } from './rotas-relatorios-gestao.js'
import { faixaDeDias, mediaDe } from './relatorios-gestao.js'
import { diasDoPeriodo, fatia, ticketMedio } from './relatorios-vendas.js'
import { lerLimiteMin } from './relatorios-whatsapp.js'

/**
 * Relatórios de gestão, 1ª leva (E2): vendas por dimensão, tempo de conversão, vendedores,
 * operacional e WhatsApp. Banco real, papel da aplicação (RLS), fuso do tenant America/Sao_Paulo (-03:00).
 *
 * Tenant T (com admin → escopo estrito): admin ADM, gestor GX da filial FX, vendedores VA (FX) e VB (FY).
 * Tenant O: 12 vendedores com um contato novo cada (limite do top 10) e dados que NUNCA aparecem em T.
 *
 * Setembro/2026 (janela local [01/09 00:00, 01/10 00:00) = [01/09 03:00Z, 01/10 03:00Z)):
 *   pedidos efetivados   P1 c1 VA 25000 (08/09; S1 2x10000 + S2 1x5000; conversa CV1)   P2 c2 VA 10000 (09/09; S1)
 *     P3 c3 VB 7000 (30/09 23:30 local = 01/10 02:30Z)   P3b c1 VA 3000 (20/09)   P4 c4 VB 12000 (15/09)
 *     P5 c5 VA 5000 (15/09)   P7 c2 VA 1000 (01/09 00:00 local, 1º instante)   => 7 pedidos, 63000
 *   FORA: P6 c2 (31/08 23:59 local), rascunho, contato de simulação.
 *   c4 já tinha pedido em 2025 (1ª compra fora do período); c2 comprou 1ª vez em P6 (agosto).
 */
const T = 'e2e20000-0000-4000-8000-000000000001'
const O = 'e2e20000-0000-4000-8000-000000000002'
const PV = 'e2e20000-1111-4000-8000-000000000001'
const PV2 = 'e2e20000-1111-4000-8000-000000000002'
const PLANO = 'e2e20000-3333-4000-8000-000000000001'
const MODELO = 'e2e20000-4444-4000-8000-000000000001'
const FX = 'e2e20000-5555-4000-8000-000000000001'
const FY = 'e2e20000-5555-4000-8000-000000000002'
const u = (n: number): string => `e2e20000-aaaa-4000-8000-${String(n).padStart(12, '0')}`
const ADM = u(1), GX = u(2), VA = u(3), VB = u(4)
const OU = u(101)
const sub = (id: string) => `e2e-sub-${id.slice(-3)}`
const c = (n: number): string => `e2e20000-bbbb-4000-8000-${String(n).padStart(12, '0')}`
const p = (n: number): string => `e2e20000-cccc-4000-8000-${String(n).padStart(12, '0')}`
const x = (n: number): string => `e2e20000-dddd-4000-8000-${String(n).padStart(12, '0')}`
const ORIGEM = x(1), CAN = x(2), CANI = x(3), CV1 = x(4), CV2 = x(5), CVI = x(6), ETA = x(7), ETB = x(8), F1 = x(9), F2 = x(10)

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
async function chamar(quem: string | null, url: string, tenant = T) {
  const headers: Record<string, string> = { 'x-tenant-id': tenant }
  if (quem) headers['x-teste-sub'] = sub(quem)
  const r = await app.inject({ method: 'GET', url, headers })
  return { status: r.statusCode, corpo: r.json() as Record<string, any> }
}
const SET = 'inicio=2026-09-01&fim=2026-09-30'
const OUT = 'inicio=2026-10-01&fim=2026-10-31'

async function pedido(n: number, contato: string, vendedor: string | null, valor: number, quando: string | null, estado = 'efetivado', conversa: string | null = null) {
  await dono`INSERT INTO pedido (tenant_id, id, contato_id, vendedor_id, conversa_id, estado, total_centavos, efetivado_em)
             VALUES (${T}, ${p(n)}, ${contato}, ${vendedor}, ${conversa}, ${estado}, ${valor}, ${quando})`
}
async function contato(n: number, criado: string, dono_: string | null, extra: { origem?: string; simulacao?: boolean } = {}) {
  await dono`INSERT INTO contato (tenant_id, id, nome, criado_em, origem_id, origem_carga)
             VALUES (${T}, ${c(n)}, ${'Contato ' + n}, ${criado}, ${extra.origem ?? null}, ${extra.simulacao ? 'simulacao' : null})`
  if (dono_) await dono`INSERT INTO carteira_atribuicao (tenant_id, id, contato_id, usuario_id) VALUES (${T}, gen_random_uuid(), ${c(n)}, ${dono_})`
}

async function limpar(): Promise<void> {
  for (const t of [T, O]) {
    await dono`DELETE FROM mensagem WHERE tenant_id = ${t}`
    await dono`DELETE FROM pedido WHERE tenant_id = ${t}`
    await dono`DELETE FROM atendimento WHERE tenant_id = ${t}`
    await dono`DELETE FROM conversa WHERE tenant_id = ${t}`
    await dono`DELETE FROM canal_conectado WHERE tenant_id = ${t}`
    await dono`DELETE FROM pedido WHERE tenant_id = ${t}`
    await dono`DELETE FROM tarefa WHERE tenant_id = ${t}`
    await dono`DELETE FROM oportunidade WHERE tenant_id = ${t}`
    await dono`DELETE FROM formulario_resposta WHERE tenant_id = ${t}`
    await dono`DELETE FROM formulario WHERE tenant_id = ${t}`
    await dono`DELETE FROM carteira_atribuicao WHERE tenant_id = ${t}`
    await dono`DELETE FROM contato WHERE tenant_id = ${t}`
    await dono`DELETE FROM funil_etapa WHERE tenant_id = ${t}`
    await dono`DELETE FROM origem WHERE tenant_id = ${t}`
    await dono`DELETE FROM usuario_filial WHERE tenant_id = ${t}`
    await dono`DELETE FROM usuario WHERE tenant_id = ${t}`
    await dono`DELETE FROM filial WHERE tenant_id = ${t}`
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await limpar()
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-e2', 'Pro')`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-e2', 'Varejo')`
  for (const [t, pv, nome] of [[T, PV, 'T'], [O, PV2, 'O']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id, fuso) VALUES (${t}, ${nome}, ${PLANO}, ${pv}, 'America/Sao_Paulo')`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo')`
    })
  }
  await dono`INSERT INTO filial (tenant_id, id, nome) VALUES (${T}, ${FX}, 'Filial X'), (${T}, ${FY}, 'Filial Y')`
  for (const [id, nome] of [[ADM, 'Ana Admin'], [GX, 'Gil Gestor'], [VA, 'Vera Vendedora'], [VB, 'Beto Vendedor']] as const) {
    await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${T}, ${id}, ${sub(id)}, ${nome}, ${sub(id) + '@e2.test'})`
  }
  await dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES
    (${T}, ${ADM}, NULL, 'admin'), (${T}, ${GX}, ${FX}, 'gestor'), (${T}, ${VA}, ${FX}, 'vendedor'), (${T}, ${VB}, ${FY}, 'vendedor')`
  await dono`INSERT INTO origem (tenant_id, id, nome) VALUES (${T}, ${ORIGEM}, 'Instagram')`

  // Contatos (criado_em UTC). Dono = carteira vigente.
  await contato(1, '2026-09-01T12:00:00Z', VA, { origem: ORIGEM })
  await contato(2, '2026-08-20T12:00:00Z', VA, { origem: ORIGEM })
  await contato(3, '2026-09-10T15:00:00Z', VB)
  await contato(4, '2025-01-01T12:00:00Z', VB)
  await contato(5, '2026-06-01T12:00:00Z', VA)
  await contato(6, '2026-07-07T12:00:00Z', VA)
  await contato(7, '2026-07-06T12:00:00Z', VA)
  await contato(8, '2026-09-04T12:00:00Z', VA)
  await contato(9, '2026-09-28T12:00:00Z', VB)
  await contato(10, '2026-09-20T12:00:00Z', VB)
  await contato(11, '2026-09-19T12:00:00Z', VB)
  await contato(12, '2026-08-06T12:00:00Z', VB)
  await contato(13, '2026-08-05T12:00:00Z', VB)
  await contato(14, '2026-08-02T12:00:00Z', VB)
  await contato(15, '2026-07-02T12:00:00Z', VB)
  await dono`UPDATE contato SET primeira_venda_em = '2026-01-01T12:00:00Z' WHERE tenant_id = ${T} AND id = ${c(15)}`
  await contato(99, '2026-09-05T12:00:00Z', null, { simulacao: true })

  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES
    (${T}, ${CAN}, 'whatsapp_nao_oficial', 'Zap Loja', 'conectado'), (${T}, ${CANI}, 'instagram', 'Insta', 'conectado')`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, criado_em) VALUES
    (${T}, ${CV1}, ${CAN}, ${c(1)}, '2026-09-10T12:00:00Z'),
    (${T}, ${CV2}, ${CAN}, ${c(3)}, '2026-10-01T02:30:00Z'),
    (${T}, ${CVI}, ${CANI}, ${c(1)}, '2026-09-12T12:00:00Z')`

  // Pedidos de setembro (ver o cabeçalho) e de fora do período.
  await pedido(1, c(1), VA, 25000, '2026-09-08T12:00:00Z', 'efetivado', CV1)
  await pedido(2, c(2), VA, 10000, '2026-09-09T12:00:00Z')
  await pedido(3, c(3), VB, 7000, '2026-10-01T02:30:00Z')
  await pedido(30, c(1), VA, 3000, '2026-09-20T15:00:00Z')
  await pedido(4, c(4), VB, 12000, '2026-09-15T15:00:00Z')
  await pedido(40, c(4), VB, 800, '2025-06-01T15:00:00Z')
  await pedido(5, c(5), VA, 5000, '2026-09-15T12:00:00Z')
  await pedido(7, c(2), VA, 1000, '2026-09-01T03:00:00Z')
  await pedido(6, c(2), VA, 99999, '2026-09-01T02:59:00Z')
  await pedido(8, c(1), VA, 55555, null, 'rascunho')
  await pedido(9, c(99), VA, 4444, '2026-09-05T12:00:00Z')
  await dono`INSERT INTO pedido_item (tenant_id, pedido_id, seq, sku_snapshot, descricao_snapshot, quantidade, valor_unitario_centavos) VALUES
    (${T}, ${p(1)}, 1, 'S1', 'Camiseta', 2, 10000), (${T}, ${p(1)}, 2, 'S2', 'Calça', 1, 5000), (${T}, ${p(2)}, 1, 'S1', 'Camiseta', 1, 10000)`
  // Pedidos de outubro e agosto (tempo de conversão por faixa e mês anterior).
  const out: [number, number, string][] = [
    [10, 6, '2026-10-05T12:00:00Z'], [11, 7, '2026-10-05T12:00:00Z'], [12, 8, '2026-10-05T12:00:00Z'],
    [13, 9, '2026-10-05T11:00:00Z'], [14, 10, '2026-10-05T12:00:00Z'], [15, 11, '2026-10-05T12:00:00Z'],
    [16, 12, '2026-10-05T12:00:00Z'], [17, 13, '2026-10-05T12:00:00Z'],
  ]
  for (const [n, ct, q] of out) await pedido(n, c(ct), null, 1000, q)
  await pedido(19, c(15), null, 1000, '2026-10-06T12:00:00Z')   // cliente antigo do ERP: não é conversão rápida
  await pedido(18, c(14), null, 4000, '2026-08-10T12:00:00Z')

  // Tarefas: VA concluiu 2 em setembro; a de VB foi concluída 30/09 23:30 local sem registrar quem (conta o responsável).
  await dono`INSERT INTO tarefa (tenant_id, id, titulo, vence_em, estado, concluida_em, concluida_por, responsavel_id, criado_por) VALUES
    (${T}, ${x(20)}, 'T1', now(), 'concluida', '2026-09-12T12:00:00Z', ${VA}, ${VA}, ${ADM}),
    (${T}, ${x(21)}, 'T2', now(), 'concluida', '2026-09-13T12:00:00Z', ${VA}, ${VA}, ${ADM}),
    (${T}, ${x(22)}, 'T3', now(), 'concluida', '2026-10-01T02:30:00Z', NULL, ${VB}, ${ADM}),
    (${T}, ${x(23)}, 'T4', now(), 'concluida', '2026-09-01T02:59:00Z', ${VA}, ${VA}, ${ADM}),
    (${T}, ${x(24)}, 'T5', now(), 'aberta', NULL, NULL, ${VA}, ${ADM})`

  // Funil: foto de agora.
  await dono`INSERT INTO funil_etapa (tenant_id, id, ordem, chave, nome, tipo) VALUES
    (${T}, ${ETA}, 1, 'lead-e2', 'Lead', 'aberto'), (${T}, ${ETB}, 2, 'prop-e2', 'Proposta', 'aberto')`
  await dono`INSERT INTO oportunidade (tenant_id, id, contato_id, etapa_id, posicao, estado) VALUES
    (${T}, ${x(30)}, ${c(1)}, ${ETA}, 1, 'aberta'), (${T}, ${x(31)}, ${c(3)}, ${ETA}, 2, 'aberta'),
    (${T}, ${x(32)}, ${c(5)}, ${ETB}, 1, 'aberta'), (${T}, ${x(33)}, ${c(2)}, ${ETA}, 3, 'ganha')`

  // Formulários: 2 respostas (uma sem contato) na LP Verão, 1 na Inverno, 1 fora do período.
  for (const [id, nome, slug] of [[F1, 'LP Verão', 'verao-e2'], [F2, 'LP Inverno', 'inverno-e2']] as const) {
    await dono`INSERT INTO formulario (tenant_id, id, nome, slug, chave_publica, titulo) VALUES (${T}, ${id}, ${nome}, ${slug}, ${'e2chavepublica' + id.slice(-2) + 'abcdef'}, ${nome})`
  }
  await dono`INSERT INTO formulario_resposta (tenant_id, id, formulario_id, contato_id, respostas, criado_em) VALUES
    (${T}, ${x(40)}, ${F1}, ${c(1)}, '{}', '2026-09-10T12:00:00Z'), (${T}, ${x(41)}, ${F1}, NULL, '{}', '2026-09-11T12:00:00Z'),
    (${T}, ${x(42)}, ${F2}, ${c(3)}, '{}', '2026-09-12T12:00:00Z'), (${T}, ${x(43)}, ${F2}, ${c(3)}, '{}', '2026-09-01T02:59:00Z')`

  // WhatsApp: atendimentos (A4 é do Instagram) e mensagens.
  await dono`INSERT INTO atendimento (tenant_id, id, conversa_id, canal_id, protocolo, estado, criado_em,
                                      primeira_entrante_em, primeira_resposta_em, primeira_resposta_humana_em) VALUES
    (${T}, ${x(50)}, ${CV1}, ${CAN}, 1, 'encerrado', '2026-09-10T12:00:00Z', '2026-09-10T12:00:00Z', '2026-09-10T12:00:30Z', '2026-09-10T12:03:00Z'),
    (${T}, ${x(51)}, ${CV1}, ${CAN}, 2, 'encerrado', '2026-09-11T12:00:00Z', '2026-09-11T12:00:00Z', '2026-09-11T12:10:00Z', '2026-09-11T12:10:00Z'),
    (${T}, ${x(52)}, ${CV2}, ${CAN}, 3, 'encerrado', '2026-10-01T02:30:00Z', '2026-10-01T02:30:00Z', NULL, NULL),
    (${T}, ${x(54)}, ${CV1}, ${CAN}, 5, 'encerrado', '2026-09-12T12:00:00Z', '2026-09-12T12:00:00Z', '2026-09-12T11:59:00Z', '2026-09-12T11:59:00Z'),
    (${T}, ${x(53)}, ${CVI}, ${CANI}, 4, 'encerrado', '2026-09-12T12:00:00Z', '2026-09-12T12:00:00Z', '2026-09-12T12:01:00Z', '2026-09-12T12:01:00Z')`
  const msg = (n: number, conv: string, dir: string, quando: string, autor: string | null, tipo = 'texto', status: string | null = null) =>
    dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, status, conteudo, criado_em, enviada_por_id)
         VALUES (${T}, ${x(60 + n)}, ${conv}, ${dir}, ${tipo}, ${status}, '{"texto":"oi"}'::jsonb, ${quando}, ${autor})`
  await msg(1, CV1, 'entrante', '2026-09-10T12:00:00Z', null)
  await msg(2, CV1, 'entrante', '2026-09-11T12:00:00Z', null)
  await msg(3, CV2, 'entrante', '2026-10-01T02:30:00Z', null)
  await msg(4, CV1, 'saliente', '2026-09-10T12:03:00Z', VA)
  await msg(5, CV1, 'saliente', '2026-09-10T12:00:30Z', null)
  await msg(6, CV1, 'saliente', '2026-09-01T03:00:00Z', null)
  await msg(7, CV1, 'saliente', '2026-09-01T02:59:00Z', null)
  await msg(8, CVI, 'entrante', '2026-09-12T12:00:00Z', null)
  await msg(9, CV1, 'saliente', '2026-09-10T12:05:00Z', null, 'sistema')            // aviso de handoff: não é mensagem
  await msg(10, CV1, 'saliente', '2026-09-10T13:00:00Z', VA, 'texto', 'falhou')    // não chegou: vai em "falhas"

  // Tenant O: 12 vendedores com um contato novo em setembro; um deles com nome que nunca pode vazar para T.
  for (let i = 1; i <= 12; i++) {
    await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${O}, ${u(100 + i)}, ${sub(u(100 + i))}, ${'Alheio ' + i}, ${'o' + i + '@e2.test'})`
    await dono`INSERT INTO contato (tenant_id, id, nome, criado_em) VALUES (${O}, ${c(200 + i)}, ${'Alheio c' + i}, '2026-09-10T12:00:00Z')`
    await dono`INSERT INTO carteira_atribuicao (tenant_id, id, contato_id, usuario_id) VALUES (${O}, gen_random_uuid(), ${c(200 + i)}, ${u(100 + i)})`
  }
  await dono`INSERT INTO pedido (tenant_id, id, contato_id, estado, total_centavos, efetivado_em)
             VALUES (${O}, ${p(300)}, ${c(201)}, 'efetivado', 777777, '2026-09-10T15:00:00Z')`

  app = Fastify()
  await app.register(pluginTenant)
  app.addHook('onRequest', async (req) => {
    const s = req.headers['x-teste-sub']
    if (typeof s === 'string') { req.usuarioSub = s; req.usuarioEmail = `${s}@e2.test` }
  })
  await app.register(rotasRelatoriosGestao)
  await app.ready()
})

afterAll(async () => {
  await limpar()
  await app?.close(); await encerrarBanco(); await dono.end()
})

describe('regras puras', () => {
  it('faixas de tempo: fronteiras inclusivas', () => {
    const casos: [number, string][] = [[0, '0-7'], [7, '0-7'], [8, '8-15'], [15, '8-15'], [16, '16-30'], [30, '16-30'],
      [31, '31-60'], [60, '31-60'], [61, '61-90'], [90, '61-90'], [91, '90+'], [400, '90+']]
    for (const [d, f] of casos) expect(faixaDeDias(d), `${d} dias`).toBe(f)
  })
  it('ticket, fatia, média e dias do período', () => {
    expect(ticketMedio(63000, 7)).toBe(9000)
    expect(ticketMedio(100, 0)).toBe(0)
    expect(fatia(30000, 35000)).toBe(0.8571)
    expect(fatia(1, 0)).toBe(0)
    expect(mediaDe(133, 3)).toBe(44.3)
    expect(mediaDe(0, 0)).toBeNull()
    expect(diasDoPeriodo('2026-02-27', '2026-03-02')).toEqual(['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02'])
  })
  it('limiteMin: 1..1440, padrão 5', () => {
    expect(lerLimiteMin(undefined)).toBe(5)
    expect(lerLimiteMin('10')).toBe(10)
    for (const ruim of ['0', '1441', '-1', 'abc', '1.5', '']) expect(lerLimiteMin(ruim), ruim).toBeNull()
  })
})

describe('validação comum', () => {
  it('período inválido → 422 tipificado em todos os relatórios', async () => {
    for (const rota of ['vendas-por/dia', 'tempo-conversao', 'vendedores', 'operacional', 'whatsapp']) {
      expect((await chamar(ADM, `/v1/relatorios/${rota}?inicio=2026-09-01`)).corpo.erro, rota).toBe('periodo.incompleto')
      const longo = await chamar(ADM, `/v1/relatorios/${rota}?inicio=2024-01-01&fim=2026-01-01`)
      expect(longo.status, rota).toBe(422)
      expect(longo.corpo.erro).toBe('periodo.longo_demais')
    }
  })
  it('dimensão desconhecida → 404; limiteMin inválido → 422', async () => {
    expect((await chamar(ADM, `/v1/relatorios/vendas-por/formulario?${SET}`)).status).toBe(404)
    const r = await chamar(ADM, `/v1/relatorios/whatsapp?${SET}&limiteMin=0`)
    expect(r.status).toBe(422)
    expect(r.corpo.erro).toBe('relatorio.limite_invalido')
  })
})

describe('vendas por dimensão', () => {
  const vendas = async (quem: string | null, dim: string, q = SET) => (await chamar(quem, `/v1/relatorios/vendas-por/${dim}?${q}`)).corpo

  it('totais: só efetivados, fronteiras do período no fuso, sem simulação e sem o tenant alheio', async () => {
    const r = await vendas(ADM, 'cliente')
    expect(r.totais).toEqual({ pedidos: 7, valorCentavos: 63000, ticketMedioCentavos: 9000 })
    expect(r.periodo).toEqual({ inicio: '2026-09-01', fim: '2026-09-30', fuso: 'America/Sao_Paulo' })
    expect(JSON.stringify(r)).not.toContain('Alheio')
  })
  it('dia: série completa, o pedido de 23:30 local cai em 30/09 e o do 1º instante em 01/09', async () => {
    const r = await vendas(ADM, 'dia')
    expect(r.itens).toHaveLength(30)
    const dia = (d: string) => r.itens.find((i: any) => i.chave === d)
    expect(dia('2026-09-30')).toMatchObject({ pedidos: 1, valorCentavos: 7000 })
    expect(dia('2026-09-01')).toMatchObject({ pedidos: 1, valorCentavos: 1000 })
    expect(dia('2026-09-02')).toMatchObject({ pedidos: 0, valorCentavos: 0, ticketMedioCentavos: 0, percentual: 0 })
  })
  it('dia-semana: 7 dias, segunda a domingo', async () => {
    const r = await vendas(ADM, 'dia-semana')
    expect(r.itens.map((i: any) => i.rotulo)).toEqual(['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado', 'Domingo'])
    expect(r.itens[1]).toMatchObject({ pedidos: 4, valorCentavos: 43000 })
    expect(r.itens[2]).toMatchObject({ pedidos: 2, valorCentavos: 17000 })
    expect(r.itens[6]).toMatchObject({ pedidos: 1, valorCentavos: 3000 })
  })
  it('vendedor, origem, canal e cliente somam o total e carregam ticket e percentual', async () => {
    const v = await vendas(ADM, 'vendedor')
    expect(v.itens).toEqual([
      { chave: VA, rotulo: 'Vera Vendedora', pedidos: 5, valorCentavos: 44000, ticketMedioCentavos: 8800, percentual: 0.6984 },
      { chave: VB, rotulo: 'Beto Vendedor', pedidos: 2, valorCentavos: 19000, ticketMedioCentavos: 9500, percentual: 0.3016 },
    ])
    const o = await vendas(ADM, 'origem')
    expect(o.itens.map((i: any) => [i.rotulo, i.pedidos, i.valorCentavos])).toEqual([['Instagram', 4, 39000], ['Sem origem', 3, 24000]])
    const ca = await vendas(ADM, 'canal')
    expect(ca.itens.map((i: any) => [i.rotulo, i.pedidos, i.valorCentavos])).toEqual([['Sem canal', 6, 38000], ['Zap Loja', 1, 25000]])
    const cl = await vendas(ADM, 'cliente')
    expect(cl.itens[0]).toMatchObject({ rotulo: 'Contato 1', valorCentavos: 28000, pedidos: 2 })
    expect(cl.itens.reduce((s: number, i: any) => s + i.valorCentavos, 0)).toBe(63000)
  })
  it('produto: valor dos itens, pedidos distintos, unidades vendidas e fatia sobre a soma dos itens', async () => {
    const r = await vendas(ADM, 'produto')
    expect(r.itens).toEqual([
      { chave: 'S1', rotulo: 'Camiseta', pedidos: 2, valorCentavos: 30000, ticketMedioCentavos: 15000, percentual: 0.8571, quantidade: 3 },
      { chave: 'S2', rotulo: 'Calça', pedidos: 1, valorCentavos: 5000, ticketMedioCentavos: 5000, percentual: 0.1429, quantidade: 1 },
    ])
  })
  it('quantidade só existe na dimensão produto', async () => {
    const r = await vendas(ADM, 'cliente')
    expect(r.itens.every((i: any) => !('quantidade' in i))).toBe(true)
  })
  it('período sem vendas: grupos vazios, totais zerados', async () => {
    const r = await vendas(ADM, 'vendedor', 'inicio=2020-01-01&fim=2020-01-31')
    expect(r.itens).toEqual([])
    expect(r.totais).toEqual({ pedidos: 0, valorCentavos: 0, ticketMedioCentavos: 0 })
    expect(r.truncado).toBe(false)
  })
  it('escopo: vendedor só a própria carteira; gestor a filial; admin tudo; outro tenant isolado', async () => {
    expect((await vendas(VA, 'vendedor')).totais).toEqual({ pedidos: 5, valorCentavos: 44000, ticketMedioCentavos: 8800 })
    expect((await vendas(VB, 'vendedor')).totais).toMatchObject({ pedidos: 2, valorCentavos: 19000 })
    expect((await vendas(GX, 'vendedor')).totais).toMatchObject({ pedidos: 5, valorCentavos: 44000 })
    expect((await vendas(ADM, 'vendedor')).totais.pedidos).toBe(7)
    const outro = (await chamar(OU, `/v1/relatorios/vendas-por/cliente?${SET}`, O)).corpo
    expect(outro.totais).toMatchObject({ pedidos: 1, valorCentavos: 777777 })
    expect(outro.itens).toHaveLength(1)
  })
})

describe('tempo de conversão', () => {
  it('setembro: 1ª compra no período (recompra e 1ª compra fora ficam de fora), média e extremos', async () => {
    const r = (await chamar(ADM, `/v1/relatorios/tempo-conversao?${SET}`)).corpo
    // c1 = 7 dias, c3 = 20 dias (compra às 23:30 locais do último dia), c5 = 106 dias.
    expect(r).toMatchObject({ contatos: 3, mediaDias: 44.3, maisRapidaDias: 7, maisLentaDias: 106 })
    expect(r.faixas).toEqual([
      { faixa: '0-7', contatos: 1, percentual: 0.3333 }, { faixa: '8-15', contatos: 0, percentual: 0 },
      { faixa: '16-30', contatos: 1, percentual: 0.3333 }, { faixa: '31-60', contatos: 0, percentual: 0 },
      { faixa: '61-90', contatos: 0, percentual: 0 }, { faixa: '90+', contatos: 1, percentual: 0.3333 },
    ])
  })
  it('outubro: cada fronteira de faixa cai na faixa certa; por vendedor', async () => {
    const r = (await chamar(ADM, `/v1/relatorios/tempo-conversao?${OUT}`)).corpo
    // 90, 91, 31, 6 (6d23h), 15, 16, 60, 61 dias
    expect(r).toMatchObject({ contatos: 8, mediaDias: 46.3, maisRapidaDias: 6, maisLentaDias: 91 })
    expect(r.faixas.map((f: any) => f.contatos)).toEqual([1, 1, 1, 2, 2, 1])
    expect(r.porVendedor).toEqual([
      { chave: VB, rotulo: 'Beto Vendedor', contatos: 5, mediaDias: 31.6, maisRapidaDias: 6, maisLentaDias: 61 },
      { chave: VA, rotulo: 'Vera Vendedora', contatos: 3, mediaDias: 70.7, maisRapidaDias: 31, maisLentaDias: 91 },
    ])
  })
  it('sem conversões: nulos e faixas zeradas; escopo do vendedor', async () => {
    const vazio = (await chamar(ADM, `/v1/relatorios/tempo-conversao?inicio=2020-01-01&fim=2020-01-31`)).corpo
    expect(vazio).toMatchObject({ contatos: 0, mediaDias: null, maisRapidaDias: null, maisLentaDias: null, porVendedor: [] })
    expect(vazio.faixas).toHaveLength(6)
    const va = (await chamar(VA, `/v1/relatorios/tempo-conversao?${SET}`)).corpo
    expect(va).toMatchObject({ contatos: 2, maisRapidaDias: 7, maisLentaDias: 106 })
    expect((await chamar(OU, `/v1/relatorios/tempo-conversao?${SET}`, O)).corpo.contatos).toBe(1)
  })
})

describe('vendedores', () => {
  it('coorte do E1 + tarefas concluídas no período, ordenado por valor', async () => {
    const r = (await chamar(ADM, `/v1/relatorios/vendedores?${SET}`)).corpo
    expect(r.totalVendedores).toBe(2)
    expect(r.itens).toEqual([
      { usuarioId: VA, nome: 'Vera Vendedora', contatosNovos: 2, tarefasConcluidas: 2, conversoes: 1, taxa: 0.5,
        pedidos: 2, valorCentavos: 28000, ticketMedioCentavos: 14000 },
      { usuarioId: VB, nome: 'Beto Vendedor', contatosNovos: 4, tarefasConcluidas: 1, conversoes: 1, taxa: 0.25,
        pedidos: 1, valorCentavos: 7000, ticketMedioCentavos: 7000 },
    ])
  })
  it('escopo: vendedor só vê a si; gestor da filial vê a filial', async () => {
    const va = (await chamar(VA, `/v1/relatorios/vendedores?${SET}`)).corpo
    expect(va.itens.map((i: any) => i.usuarioId)).toEqual([VA])
    const gx = (await chamar(GX, `/v1/relatorios/vendedores?${SET}`)).corpo
    expect(gx.itens.map((i: any) => i.usuarioId)).toEqual([VA])
  })
  it('escopo carteira: "em atendimento comigo" e tarefa que eu criei não trazem colegas para o ranking', async () => {
    // VA atende agora a conversa de c3 (carteira de VB) e criou uma tarefa concluída por VB.
    await dono`INSERT INTO atendimento (tenant_id, id, conversa_id, canal_id, protocolo, estado, atendente_id, criado_em)
               VALUES (${T}, ${x(70)}, ${CV2}, ${CAN}, 90, 'em_atendimento', ${VA}, '2026-11-01T12:00:00Z')`
    await dono`INSERT INTO tarefa (tenant_id, id, titulo, vence_em, estado, concluida_em, concluida_por, responsavel_id, criado_por)
               VALUES (${T}, ${x(71)}, 'T6', now(), 'concluida', '2026-09-14T12:00:00Z', ${VB}, ${VB}, ${VA})`
    try {
      const va = (await chamar(VA, `/v1/relatorios/vendedores?${SET}`)).corpo
      expect(va.itens.map((i: any) => i.usuarioId)).toEqual([VA])
      expect(va.totalVendedores).toBe(1)
      const adm = (await chamar(ADM, `/v1/relatorios/vendedores?${SET}`)).corpo
      expect(adm.totalVendedores).toBe(2)
      expect(adm.itens.find((i: any) => i.usuarioId === VB).tarefasConcluidas).toBe(2)
    } finally {
      await dono`DELETE FROM tarefa WHERE tenant_id = ${T} AND id = ${x(71)}`
      await dono`DELETE FROM atendimento WHERE tenant_id = ${T} AND id = ${x(70)}`
    }
  })
  it('escopo filial: só quem tem papel na filial do gestor', async () => {
    const gx = (await chamar(GX, `/v1/relatorios/vendedores?${SET}`)).corpo
    expect(gx.itens.map((i: any) => i.usuarioId)).toEqual([VA])
    expect(gx.totalVendedores).toBe(1)
  })
  it('top 10: corta em 10 e informa o total; nunca mistura tenants', async () => {
    const o = (await chamar(OU, `/v1/relatorios/vendedores?${SET}`, O)).corpo
    expect(o.itens).toHaveLength(10)
    expect(o.totalVendedores).toBe(12)
    expect(o.itens[0].nome).toBe('Alheio 1')
    expect(JSON.stringify((await chamar(ADM, `/v1/relatorios/vendedores?${SET}`)).corpo)).not.toContain('Alheio')
  })
})

describe('operacional', () => {
  it('mês atual × anterior (mesmo dia do mês), funil, tops e formulários', async () => {
    const r = (await chamar(ADM, `/v1/relatorios/operacional?${SET}`)).corpo
    expect(r.mesAtual).toEqual({ inicio: '2026-09-01', fim: '2026-09-30', contatosNovos: 6, conversoes: 2, valorCentavos: 35000 })
    // Agosto até o dia 30: o pedido de 31/08 23:59 local fica de fora de propósito.
    expect(r.mesAnterior).toEqual({ inicio: '2026-08-01', fim: '2026-08-30', contatosNovos: 4, conversoes: 1, valorCentavos: 4000 })
    expect(r.funil).toEqual([
      { chave: 'lead-e2', rotulo: 'Lead', oportunidades: 2 }, { chave: 'prop-e2', rotulo: 'Proposta', oportunidades: 1 },
    ])
    expect(r.topOrigens).toEqual([
      { chave: 'sem-origem', rotulo: 'Sem origem', total: 5 }, { chave: ORIGEM, rotulo: 'Instagram', total: 1 },
    ])
    expect(r.topFormularios).toEqual([
      { chave: F1, rotulo: 'LP Verão', total: 2 }, { chave: F2, rotulo: 'LP Inverno', total: 1 },
    ])
  })
  it('mês anterior limitado ao último dia dele (31/03 → 28/02)', async () => {
    const r = (await chamar(ADM, `/v1/relatorios/operacional?inicio=2026-03-01&fim=2026-03-31`)).corpo
    expect(r.mesAnterior).toMatchObject({ inicio: '2026-02-01', fim: '2026-02-28' })
  })
  it('escopo: vendedor vê só o próprio funil, as próprias origens e as respostas de contato dele', async () => {
    const r = (await chamar(VA, `/v1/relatorios/operacional?${SET}`)).corpo
    expect(r.mesAtual).toMatchObject({ contatosNovos: 2, conversoes: 1, valorCentavos: 28000 })
    expect(r.funil.map((e: any) => e.oportunidades)).toEqual([1, 1])
    expect(r.topFormularios).toEqual([{ chave: F1, rotulo: 'LP Verão', total: 1 }])
    expect((await chamar(OU, `/v1/relatorios/operacional?${SET}`, O)).corpo.funil).toEqual([])
  })
})

describe('whatsapp', () => {
  it('cards e série diária: só canais WhatsApp, fronteira local, dia sem mensagem = 0', async () => {
    const r = (await chamar(ADM, `/v1/relatorios/whatsapp?${SET}`)).corpo
    expect(r.limiteMin).toBe(5)
    expect(r.cartoes).toMatchObject({ recebidas: 3, enviadas: 3, enviadasHumanas: 1, enviadasAutomaticas: 2, falhas: 1, conversasIniciadas: 2 })
    expect(r.porDia).toHaveLength(30)
    const dia = (d: string) => r.porDia.find((x: any) => x.dia === d)
    expect(dia('2026-09-10')).toEqual({ dia: '2026-09-10', recebidas: 1, enviadas: 2 })
    expect(dia('2026-09-30')).toEqual({ dia: '2026-09-30', recebidas: 1, enviadas: 0 })
    expect(dia('2026-09-01')).toEqual({ dia: '2026-09-01', recebidas: 0, enviadas: 1 })
    expect(dia('2026-09-02')).toEqual({ dia: '2026-09-02', recebidas: 0, enviadas: 0 })
  })
  it('1ª resposta: p50/p95 por autor e % no limite configurável', async () => {
    const r = (await chamar(ADM, `/v1/relatorios/whatsapp?${SET}`)).corpo
    expect(r.primeiraResposta).toEqual([
      { autor: 'humano', atendimentos: 2, p50Seg: 390, p95Seg: 579 },
      { autor: 'automatico', atendimentos: 1, p50Seg: 30, p95Seg: 30 },
    ])
    expect(r.cartoes).toMatchObject({ atendimentos: 4, respondidasNoLimite: 1, pctNoLimite: 0.25 })
    const dez = (await chamar(ADM, `/v1/relatorios/whatsapp?${SET}&limiteMin=10`)).corpo
    expect(dez.cartoes).toMatchObject({ respondidasNoLimite: 2, pctNoLimite: 0.5 })
  })
  it('período sem dados: zeros e percentuais nulos', async () => {
    const r = (await chamar(ADM, `/v1/relatorios/whatsapp?inicio=2020-01-01&fim=2020-01-03`)).corpo
    expect(r.cartoes).toMatchObject({ recebidas: 0, enviadas: 0, conversasIniciadas: 0, atendimentos: 0, pctNoLimite: null })
    expect(r.primeiraResposta).toEqual([
      { autor: 'humano', atendimentos: 0, p50Seg: null, p95Seg: null },
      { autor: 'automatico', atendimentos: 0, p50Seg: null, p95Seg: null },
    ])
  })
  it('escopo: vendedor só as conversas dos contatos dele; outro tenant isolado', async () => {
    const r = (await chamar(VA, `/v1/relatorios/whatsapp?${SET}`)).corpo
    expect(r.cartoes).toMatchObject({ recebidas: 2, enviadas: 3, conversasIniciadas: 1, atendimentos: 3 })
    const o = (await chamar(OU, `/v1/relatorios/whatsapp?${SET}`, O)).corpo
    expect(o.cartoes).toMatchObject({ recebidas: 0, enviadas: 0, atendimentos: 0 })
  })
})
