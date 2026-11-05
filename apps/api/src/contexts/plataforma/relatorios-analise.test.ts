import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { encerrarBanco } from '../../db/index.js'
import { pluginTenant } from '../../plugins/tenant.js'
import { rotasRelatoriosAnalise } from './rotas-relatorios-analise.js'
import { lerVendedores } from './relatorios-analise.js'
import { contatosParaCsv, lerCursor, lerFiltros, montarCursor, type LinhaContato } from './relatorios-contatos.js'

/**
 * Relatórios de análise, 2ª leva (E3). Banco real, papel da aplicação (RLS), fuso America/Sao_Paulo (-03:00).
 *
 * Tenant T (com admin → escopo estrito): admin ADM, gestor GX da filial FX, vendedores VA (FX) e VB (FY).
 * Setembro/2026 = janela local [01/09 03:00Z, 01/10 03:00Z). Contatos (criado_em UTC):
 *   c1 VA 01/09 12:00 (origem, SP, CPF, tel, e-mail, formulário F1)   c2 VA 02/09 (SP, CNPJ, e-mail)
 *   c3 VB 10/09 (RJ, CPF, qualificado, formulário F2)                 c4 VB 01/10 02:59:59Z (30/09 23:59:59 local: DENTRO)
 *   c7 VA 01/09 03:00:00Z (1º instante: DENTRO)
 *   FORA: c5 01/10 03:00:00Z, c6 01/09 02:59:59Z, c99 simulação  => coorte = 5 (VA: c1 c2 c7; VB: c3 c4)
 *   pedidos efetivados: c1 25000 (08/09) + 3000 (20/09); c3 7000 (30/09 23:30 local)  => 3 pedidos, 35000, 2 convertidos
 *   tarefas concluídas em setembro: VA 2, VB 1.  Formulário: F1 2 respostas (uma sem contato), F2 1 (+1 fora, 31/08 local).
 *   oportunidades perdidas em setembro: preço x2, prazo x1 (+1 fora).
 * Tenant B (grande): 1100 contatos criados em setembro (CSV capado em 1000, `truncado`), 22 UFs, 25 cidades, 35 usuários
 * (opções por cursor). Nada de B aparece em T.
 */
const T = 'e3e30000-0000-4000-8000-000000000001'
const B = 'e3e30000-0000-4000-8000-000000000002'
const PV = 'e3e30000-1111-4000-8000-000000000001'
const PV2 = 'e3e30000-1111-4000-8000-000000000002'
const PLANO = 'e3e30000-3333-4000-8000-000000000001'
const MODELO = 'e3e30000-4444-4000-8000-000000000001'
const FX = 'e3e30000-5555-4000-8000-000000000001'
const FY = 'e3e30000-5555-4000-8000-000000000002'
const id = (grupo: string, n: number): string => `e3e30000-${grupo}-4000-8000-${String(n).padStart(12, '0')}`
const u = (n: number): string => id('aaaa', n)
const c = (n: number): string => id('bbbb', n)
const ADM = u(1), GX = u(2), VA = u(3), VB = u(4), BADM = u(500)
const sub = (uid: string) => `e3-sub-${uid.slice(-3)}`
const ORIGEM = id('dddd', 1), CAN = id('dddd', 2), F1 = id('dddd', 3), F2 = id('dddd', 4), ETA = id('dddd', 5)

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
async function chamar(quem: string | null, url: string, tenant = T) {
  const headers: Record<string, string> = { 'x-tenant-id': tenant }
  if (quem) headers['x-teste-sub'] = sub(quem)
  const r = await app.inject({ method: 'GET', url, headers })
  const texto = r.body
  let corpo: Record<string, any> = {}
  try { corpo = JSON.parse(texto) } catch { /* CSV */ }
  return { status: r.statusCode, corpo, texto, headers: r.headers }
}
const SET = 'inicio=2026-09-01&fim=2026-09-30'

async function limpar(): Promise<void> {
  for (const t of [T, B]) {
    await dono`DELETE FROM pedido WHERE tenant_id = ${t}`
    await dono`DELETE FROM conversa WHERE tenant_id = ${t}`
    await dono`DELETE FROM canal_conectado WHERE tenant_id = ${t}`
    await dono`DELETE FROM tarefa WHERE tenant_id = ${t}`
    await dono`DELETE FROM oportunidade WHERE tenant_id = ${t}`
    await dono`DELETE FROM motivo_perda WHERE tenant_id = ${t}`
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

async function contato(n: number, criado: string, dono_: string | null, extra: { qualificado?: boolean; origem?: string; simulacao?: boolean } = {}) {
  await dono`INSERT INTO contato (tenant_id, id, nome, criado_em, origem_id, origem_carga, qualificado, qualificado_em, email)
             VALUES (${T}, ${c(n)}, ${'Contato ' + n}, ${criado}, ${extra.origem ?? null}, ${extra.simulacao ? 'simulacao' : null},
                     ${extra.qualificado ?? null}, ${extra.qualificado === undefined ? null : criado}, ${n === 1 || n === 2 ? `c${n}@e3.test` : null})`
  if (dono_) await dono`INSERT INTO carteira_atribuicao (tenant_id, id, contato_id, usuario_id) VALUES (${T}, gen_random_uuid(), ${c(n)}, ${dono_})`
}
async function pedido(n: number, contato_: string, vendedor: string | null, valor: number, quando: string) {
  await dono`INSERT INTO pedido (tenant_id, id, contato_id, vendedor_id, estado, total_centavos, efetivado_em)
             VALUES (${T}, ${id('cccc', n)}, ${contato_}, ${vendedor}, 'efetivado', ${valor}, ${quando})`
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await limpar()
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-e3', 'Pro')`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-e3', 'Varejo')`
  for (const [t, pv, nome] of [[T, PV, 'T'], [B, PV2, 'B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id, fuso) VALUES (${t}, ${nome}, ${PLANO}, ${pv}, 'America/Sao_Paulo')`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo')`
    })
  }
  await dono`INSERT INTO filial (tenant_id, id, nome) VALUES (${T}, ${FX}, 'Filial X'), (${T}, ${FY}, 'Filial Y')`
  for (const [uid, nome] of [[ADM, 'Ana Admin'], [GX, 'Gil Gestor'], [VA, 'Vera Vendedora'], [VB, 'Beto Vendedor']] as const) {
    await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${T}, ${uid}, ${sub(uid)}, ${nome}, ${sub(uid) + '@e3.test'})`
  }
  await dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES
    (${T}, ${ADM}, NULL, 'admin'), (${T}, ${GX}, ${FX}, 'gestor'), (${T}, ${VA}, ${FX}, 'vendedor'), (${T}, ${VB}, ${FY}, 'vendedor')`
  await dono`INSERT INTO origem (tenant_id, id, nome) VALUES (${T}, ${ORIGEM}, 'Instagram')`

  await contato(1, '2026-09-01T12:00:00Z', VA, { origem: ORIGEM })
  await contato(2, '2026-09-02T12:00:00Z', VA)
  await contato(3, '2026-09-10T15:00:00Z', VB, { qualificado: true })
  await contato(4, '2026-10-01T02:59:59Z', VB)
  await contato(5, '2026-10-01T03:00:00Z', VB)
  await contato(6, '2026-09-01T02:59:59Z', VA)
  await contato(7, '2026-09-01T03:00:00Z', VA)
  await contato(99, '2026-09-05T12:00:00Z', null, { simulacao: true })

  await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, fonte)
             VALUES (${T}, ${c(1)}, 1, '+5511999990001', '5511999990001', true, 'manual')`
  await dono`INSERT INTO contato_documento (tenant_id, contato_id, seq, tipo, numero, fiscal, fonte) VALUES
    (${T}, ${c(1)}, 1, 'cpf', '11111111111', true, 'manual'), (${T}, ${c(2)}, 1, 'cnpj', '11111111000111', true, 'manual'),
    (${T}, ${c(3)}, 1, 'cpf', '22222222222', true, 'manual')`
  await dono`INSERT INTO contato_endereco (tenant_id, contato_id, seq, cidade, uf, principal, fonte) VALUES
    (${T}, ${c(1)}, 1, 'Campinas', 'SP', true, 'manual'), (${T}, ${c(2)}, 1, 'Campinas', 'SP', true, 'manual'),
    (${T}, ${c(3)}, 1, 'Niterói', 'RJ', true, 'manual')`

  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES (${T}, ${CAN}, 'whatsapp_nao_oficial', 'Zap Loja', 'conectado')`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id) VALUES (${T}, ${id('eeee', 1)}, ${CAN}, ${c(1)}), (${T}, ${id('eeee', 2)}, ${CAN}, ${c(3)})`

  await pedido(1, c(1), VA, 25000, '2026-09-08T12:00:00Z')
  await pedido(2, c(1), VA, 3000, '2026-09-20T15:00:00Z')
  await pedido(3, c(3), VB, 7000, '2026-10-01T02:30:00Z')
  await pedido(4, c(5), VB, 99999, '2026-10-01T03:00:00Z')

  await dono`INSERT INTO tarefa (tenant_id, id, titulo, vence_em, estado, concluida_em, concluida_por, responsavel_id, criado_por) VALUES
    (${T}, ${id('ffff', 1)}, 'T1', now(), 'concluida', '2026-09-12T12:00:00Z', ${VA}, ${VA}, ${ADM}),
    (${T}, ${id('ffff', 2)}, 'T2', now(), 'concluida', '2026-09-13T12:00:00Z', ${VA}, ${VA}, ${ADM}),
    (${T}, ${id('ffff', 3)}, 'T3', now(), 'concluida', '2026-10-01T02:30:00Z', NULL, ${VB}, ${ADM})`

  for (const [fid, nome, slug] of [[F1, 'LP Verão', 'verao-e3'], [F2, 'LP Inverno', 'inverno-e3']] as const) {
    await dono`INSERT INTO formulario (tenant_id, id, nome, slug, chave_publica, titulo) VALUES (${T}, ${fid}, ${nome}, ${slug}, ${'e3chavepublica' + fid.slice(-2) + 'abcdef'}, ${nome})`
  }
  await dono`INSERT INTO formulario_resposta (tenant_id, id, formulario_id, contato_id, respostas, criado_em) VALUES
    (${T}, ${id('1111', 1)}, ${F1}, ${c(1)}, '{}', '2026-09-10T12:00:00Z'), (${T}, ${id('1111', 2)}, ${F1}, NULL, '{}', '2026-09-11T12:00:00Z'),
    (${T}, ${id('1111', 3)}, ${F2}, ${c(3)}, '{}', '2026-09-12T12:00:00Z'), (${T}, ${id('1111', 4)}, ${F2}, ${c(3)}, '{}', '2026-09-01T02:59:59Z')`

  await dono`INSERT INTO funil_etapa (tenant_id, id, ordem, chave, nome, tipo) VALUES (${T}, ${ETA}, 1, 'lead-e3', 'Lead', 'aberto')`
  await dono`INSERT INTO motivo_perda (tenant_id, codigo, nome) VALUES (${T}, 'preco', 'Preço'), (${T}, 'prazo', 'Prazo')`
  const perdida = (n: number, ct: number, motivo: string, quando: string) =>
    dono`INSERT INTO oportunidade (tenant_id, id, contato_id, etapa_id, posicao, estado, motivo_perda_codigo, fechada_em)
         VALUES (${T}, ${id('2222', n)}, ${c(ct)}, ${ETA}, ${n}, 'perdida', ${motivo}, ${quando})`
  await perdida(1, 1, 'preco', '2026-09-12T12:00:00Z')
  await perdida(2, 2, 'preco', '2026-09-13T12:00:00Z')
  await perdida(3, 3, 'prazo', '2026-10-01T02:59:59Z')
  await perdida(4, 7, 'prazo', '2026-09-01T02:59:59Z')

  // Tenant B: 1100 contatos em setembro, 22 UFs, 25 cidades; 35 usuários.
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${B}, ${BADM}, ${sub(BADM)}, 'Bia Admin', 'b@e3.test')`
  await dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES (${B}, ${BADM}, NULL, 'admin')`
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email)
             SELECT ${B}, gen_random_uuid(), 'e3-b-' || n, 'Vendedor B ' || lpad(n::text, 2, '0'), 'vb' || n || '@e3.test' FROM generate_series(1, 35) n`
  await dono`INSERT INTO contato (tenant_id, id, nome, criado_em)
             SELECT ${B}, gen_random_uuid(), 'Alheio ' || n, '2026-09-10T12:00:00Z'::timestamptz + (n || ' seconds')::interval FROM generate_series(1, 1100) n`
  await dono`INSERT INTO contato_endereco (tenant_id, contato_id, seq, cidade, uf, principal, fonte)
             SELECT tenant_id, id, 1, 'Cidade ' || (row_number() OVER ())::int % 25, chr(65 + (row_number() OVER ())::int % 22) || 'X', true, 'manual'
               FROM contato WHERE tenant_id = ${B}`

  app = Fastify()
  await app.register(pluginTenant)
  app.addHook('onRequest', async (req) => {
    const s = req.headers['x-teste-sub']
    if (typeof s === 'string') { req.usuarioSub = s; req.usuarioEmail = `${s}@e3.test` }
  })
  await app.register(rotasRelatoriosAnalise)
  await app.ready()
}, 60_000)

afterAll(async () => {
  await limpar()
  await app?.close(); await encerrarBanco(); await dono.end()
})

describe('regras puras', () => {
  it('vendedores: 1..10 UUIDs distintos', () => {
    expect(lerVendedores(undefined)).toEqual({ erro: 'relatorio.vendedores_obrigatorio' })
    expect(lerVendedores(' , ')).toEqual({ erro: 'relatorio.vendedores_obrigatorio' })
    expect(lerVendedores('abc')).toEqual({ erro: 'relatorio.vendedor_invalido' })
    const dez = Array.from({ length: 10 }, (_, i) => u(i + 1))
    expect(lerVendedores(dez.join(','))).toEqual({ ids: dez })
    expect(lerVendedores([...dez, u(11)].join(','))).toEqual({ erro: 'relatorio.vendedores_demais' })
    expect(lerVendedores(`${u(1)},${u(1)}`)).toEqual({ ids: [u(1)] })
  })
  it('filtros e cursor', () => {
    expect(lerFiltros({ uf: 'sp', convertido: 'sim', qualificacao: 'novo' })).toEqual({ filtros: { uf: 'SP', convertido: true, qualificacao: 'novo' } })
    expect(lerFiltros({ uf: 'SPP' })).toEqual({ campoInvalido: 'uf' })
    expect(lerFiltros({ origemId: 'x' })).toEqual({ campoInvalido: 'origemId' })
    expect(lerFiltros({ vendedorId: 'sem-vendedor' })).toEqual({ filtros: { vendedorId: 'sem-vendedor' } })
    expect(lerFiltros({ busca: 'a' })).toEqual({ campoInvalido: 'busca' })
    const cur = montarCursor('2026-09-10T12:00:00.000000Z', c(1))
    expect(lerCursor(cur)).toEqual({ em: '2026-09-10T12:00:00.000000Z', id: c(1) })
    expect(lerCursor('lixo')).toBeNull()
    for (const ruim of ['1|' + c(1), '2026-09-10|' + c(1), '2026-09-10T12:00:00|' + c(1), '2026-09-10T12:00:00Z|nao-uuid']) {
      expect(lerCursor(Buffer.from(ruim).toString('base64url')), ruim).toBeNull()
    }
    expect(lerCursor(Buffer.from('2026-09-10T12:00:00Z|' + c(1)).toString('base64url'))).not.toBeNull()
  })
  it('CSV: telefone com + não ganha apóstrofo; o resto continua neutralizado', () => {
    const base: LinhaContato = { id: c(1), nome: '=CMD()', telefone: '+5511999990001', email: '@x', tipoPessoa: null, uf: null, cidade: null,
      origem: null, vendedor: null, filial: null, qualificacao: 'novo', formulario: null, criadoEm: '2026-09-10T12:00:00Z', convertido: false, pedidos: 0, valorCentavos: 0 }
    const csv = contatosParaCsv([base, { ...base, telefone: '+55 (11) 9' }], 'America/Sao_Paulo')
    expect(csv).toContain(';+5511999990001;')
    expect(csv).toContain(`'=CMD()`)
    expect(csv).toContain(`;'+55 (11) 9;`)
    expect(csv).toContain(`;'@x;`)
  })
})

describe('validação comum', () => {
  it('período inválido → 422 tipificado em todos os relatórios', async () => {
    for (const rota of ['visao-geral', 'contatos', 'desempenho', 'motivos-perda', 'imprimiveis', `comparativo?vendedores=${VA}`, `raio-x/vendedor/${VA}`]) {
      const sep = rota.includes('?') ? '&' : '?'
      expect((await chamar(ADM, `/v1/relatorios/${rota}${sep}inicio=2026-09-01`)).corpo.erro, rota).toBe('periodo.incompleto')
      const longo = await chamar(ADM, `/v1/relatorios/${rota}${sep}inicio=2024-01-01&fim=2026-01-01`)
      expect(longo.status, rota).toBe(422)
      expect(longo.corpo.erro).toBe('periodo.longo_demais')
    }
  })
  it('contatos: filtro, limite e cursor inválidos → 422; eixo desconhecido → 404; chave inválida → 422', async () => {
    expect((await chamar(ADM, `/v1/relatorios/contatos?${SET}&uf=zzz`)).corpo).toMatchObject({ erro: 'relatorio.filtro_invalido', campo: 'uf' })
    expect((await chamar(ADM, `/v1/relatorios/contatos?${SET}&limite=101`)).corpo.erro).toBe('relatorio.limite_invalido')
    expect((await chamar(ADM, `/v1/relatorios/contatos?${SET}&cursor=lixo`)).corpo.erro).toBe('relatorio.cursor_invalido')
    const forjado = Buffer.from('1|' + c(1)).toString('base64url')
    const r = await chamar(ADM, `/v1/relatorios/contatos?${SET}&cursor=${forjado}`)
    expect([r.status, r.corpo.erro]).toEqual([422, 'relatorio.cursor_invalido'])
    expect((await chamar(ADM, `/v1/relatorios/raio-x/produto/${VA}?${SET}`)).status).toBe(404)
    expect((await chamar(ADM, `/v1/relatorios/raio-x/vendedor/nao-uuid?${SET}`)).corpo.erro).toBe('relatorio.chave_invalida')
    expect((await chamar(ADM, `/v1/relatorios/opcoes/produto`)).status).toBe(404)
  })
})

describe('comparativo de vendedores', () => {
  it('lado a lado: contatos, tarefas, conversões, taxa, pedidos, valor e ticket (fronteiras no fuso)', async () => {
    const r = await chamar(ADM, `/v1/relatorios/comparativo?${SET}&vendedores=${VA},${VB}`)
    expect(r.status).toBe(200)
    expect(r.corpo.periodo).toMatchObject({ inicio: '2026-09-01', fim: '2026-09-30', fuso: 'America/Sao_Paulo' })
    expect(r.corpo.itens).toEqual([
      { usuarioId: VA, nome: 'Vera Vendedora', contatosNovos: 3, tarefasConcluidas: 2, conversoes: 1, taxa: 0.3333, pedidos: 2, valorCentavos: 28000, ticketMedioCentavos: 14000 },
      { usuarioId: VB, nome: 'Beto Vendedor', contatosNovos: 2, tarefasConcluidas: 1, conversoes: 1, taxa: 0.5, pedidos: 1, valorCentavos: 7000, ticketMedioCentavos: 7000 },
    ])
    expect(r.corpo.totais).toMatchObject({ contatosNovos: 5, conversoes: 2, taxa: 0.4, pedidos: 3, valorCentavos: 35000 })
  })
  it('vendedor sem atividade sai zerado; id de outro tenant é ignorado', async () => {
    const r = await chamar(ADM, `/v1/relatorios/comparativo?${SET}&vendedores=${GX},${BADM}`)
    expect(r.corpo.itens).toHaveLength(1)
    expect(r.corpo.itens[0]).toMatchObject({ usuarioId: GX, nome: 'Gil Gestor', contatosNovos: 0, taxa: null, valorCentavos: 0 })
  })
  it('até 10: 11 vendedores → 422; nenhum → 422; inválido → 422', async () => {
    const onze = Array.from({ length: 11 }, (_, i) => u(i + 1)).join(',')
    const r = await chamar(ADM, `/v1/relatorios/comparativo?${SET}&vendedores=${onze}`)
    expect(r.status).toBe(422)
    expect(r.corpo.erro).toBe('relatorio.vendedores_demais')
    expect((await chamar(ADM, `/v1/relatorios/comparativo?${SET}`)).corpo.erro).toBe('relatorio.vendedores_obrigatorio')
    expect((await chamar(ADM, `/v1/relatorios/comparativo?${SET}&vendedores=x`)).corpo.erro).toBe('relatorio.vendedor_invalido')
  })
  it('escopo: o vendedor só compara a si mesmo; o gestor da filial só quem é da filial', async () => {
    const va = await chamar(VA, `/v1/relatorios/comparativo?${SET}&vendedores=${VA},${VB}`)
    expect(va.corpo.itens.map((i: any) => i.usuarioId)).toEqual([VA])
    expect(va.corpo.itens[0]).toMatchObject({ contatosNovos: 3, valorCentavos: 28000 })
    const gx = await chamar(GX, `/v1/relatorios/comparativo?${SET}&vendedores=${VA},${VB}`)
    expect(gx.corpo.itens.map((i: any) => i.usuarioId)).toEqual([VA])
  })
})

describe('filial do contato dentro do escopo e vendedor inativo', () => {
  const GY = u(20), VM = u(21)
  const AGO = 'inicio=2026-08-01&fim=2026-08-31'
  it('dono em duas filiais: o gestor de Y vê "Filial Y" (não a X, fora do escopo dele)', async () => {
    for (const [uid, nome] of [[GY, 'Gabi Gestora'], [VM, 'Vitor Multi']] as const) {
      await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${T}, ${uid}, ${sub(uid)}, ${nome}, ${sub(uid) + '@e3.test'})`
    }
    await dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES
      (${T}, ${GY}, ${FY}, 'gestor'), (${T}, ${VM}, ${FX}, 'vendedor'), (${T}, ${VM}, ${FY}, 'vendedor')`
    await contato(20, '2026-08-10T12:00:00Z', VM)
    try {
      const gy = await chamar(GY, `/v1/relatorios/visao-geral?${AGO}`)
      expect(gy.corpo.porFilial.map((g: any) => [g.rotulo, g.contatos])).toEqual([['Filial Y', 1]])
      const rx = await chamar(GY, `/v1/relatorios/raio-x/filial/${FY}?${AGO}`)
      expect(rx.corpo.cartoes.contatos).toBe(1)
      const adm = await chamar(ADM, `/v1/relatorios/visao-geral?${AGO}`)
      expect(adm.corpo.porFilial.map((g: any) => g.rotulo)).toEqual(['Filial X']) // admin: menor id, determinístico
    } finally {
      await dono`DELETE FROM carteira_atribuicao WHERE tenant_id = ${T} AND contato_id = ${c(20)}`
      await dono`DELETE FROM contato WHERE tenant_id = ${T} AND id = ${c(20)}`
      await dono`DELETE FROM usuario_filial WHERE tenant_id = ${T} AND usuario_id IN (${GY}, ${VM})`
      await dono`DELETE FROM usuario WHERE tenant_id = ${T} AND id IN (${GY}, ${VM})`
    }
  })
  it('vendedor inativo não entra no comparativo', async () => {
    await dono`UPDATE usuario SET ativo = false WHERE tenant_id = ${T} AND id = ${VB}`
    try {
      const r = await chamar(ADM, `/v1/relatorios/comparativo?${SET}&vendedores=${VB}`)
      expect(r.corpo.itens).toEqual([])
    } finally { await dono`UPDATE usuario SET ativo = true WHERE tenant_id = ${T} AND id = ${VB}` }
  })
})

describe('opções dos selects (cursor)', () => {
  it('admin vê todos, vendedor só ele, gestor os da filial', async () => {
    const adm = await chamar(ADM, '/v1/relatorios/opcoes/vendedor')
    expect(adm.corpo.itens.map((i: any) => i.nome)).toEqual(['Ana Admin', 'Beto Vendedor', 'Gil Gestor', 'Vera Vendedora'])
    expect((await chamar(VA, '/v1/relatorios/opcoes/vendedor')).corpo.itens.map((i: any) => i.id)).toEqual([VA])
    expect((await chamar(GX, '/v1/relatorios/opcoes/vendedor')).corpo.itens.map((i: any) => i.id).sort()).toEqual([GX, VA].sort())
    expect((await chamar(GX, '/v1/relatorios/opcoes/filial')).corpo.itens.map((i: any) => i.id)).toEqual([FX])
    expect((await chamar(ADM, '/v1/relatorios/opcoes/vendedor?busca=gil')).corpo.itens).toHaveLength(1)
  })
  it('pagina por cursor sem repetir (36 usuários no tenant B, 30 por página)', async () => {
    const p1 = await chamar(BADM, '/v1/relatorios/opcoes/vendedor', B)
    expect(p1.corpo.itens).toHaveLength(30)
    expect(p1.corpo.proximoCursor).toBeTruthy()
    const p2 = await chamar(BADM, `/v1/relatorios/opcoes/vendedor?cursor=${p1.corpo.proximoCursor}`, B)
    expect(p2.corpo.itens).toHaveLength(6)
    expect(p2.corpo.proximoCursor).toBeNull()
    const ids = [...p1.corpo.itens, ...p2.corpo.itens].map((i: any) => i.id)
    expect(new Set(ids).size).toBe(36)
  })
})

describe('visão geral', () => {
  it('totais, por filial, filial × dia e por formulário', async () => {
    const r = await chamar(ADM, `/v1/relatorios/visao-geral?${SET}`)
    expect(r.status).toBe(200)
    expect(r.corpo.totais).toEqual({ contatos: 5, convertidos: 2, taxa: 0.4, pedidos: 3, valorCentavos: 35000, ticketMedioCentavos: 11667, respostasFormulario: 3 })
    expect(r.corpo.porFilial.map((g: any) => [g.rotulo, g.contatos, g.convertidos, g.valorCentavos])).toEqual([
      ['Filial X', 3, 1, 28000], ['Filial Y', 2, 1, 7000],
    ])
    const { dias, series } = r.corpo.filialPorDia
    expect(dias).toHaveLength(30)
    const fx = series.find((s: any) => s.rotulo === 'Filial X')
    expect(fx.total).toBe(3)
    expect(fx.porDia[0]).toBe(2) // c7 (01/09 00:00 local, 1º instante) e c1 (01/09 09:00 local)
    expect(fx.porDia[1]).toBe(1) // c2
    const fy = series.find((s: any) => s.rotulo === 'Filial Y')
    expect(fy.porDia[29]).toBe(1) // c4: 30/09 23:59:59 local
    expect(r.corpo.porFormulario.map((f: any) => [f.rotulo, f.respostas, f.contatos, f.convertidos, f.valorCentavos])).toEqual([
      ['LP Verão', 2, 1, 1, 28000], ['LP Inverno', 1, 1, 1, 7000],
    ])
  })
  it('escopo: vendedor vê só os dele; gestor só a filial; resposta sem contato some fora de "tudo"', async () => {
    const va = await chamar(VA, `/v1/relatorios/visao-geral?${SET}`)
    expect(va.corpo.totais).toMatchObject({ contatos: 3, convertidos: 1, valorCentavos: 28000, respostasFormulario: 1 })
    const gx = await chamar(GX, `/v1/relatorios/visao-geral?${SET}`)
    expect(gx.corpo.totais).toMatchObject({ contatos: 3, valorCentavos: 28000 })
    expect(gx.corpo.porFilial.map((g: any) => g.rotulo)).toEqual(['Filial X'])
  })
  it('dois tenants: T não vê B e B não vê T', async () => {
    const b = await chamar(BADM, `/v1/relatorios/visao-geral?${SET}`, B)
    expect(b.corpo.totais.contatos).toBe(1100)
    expect(b.corpo.porFormulario).toEqual([])
    expect((await chamar(ADM, `/v1/relatorios/visao-geral?${SET}`)).corpo.totais.contatos).toBe(5)
  })
})

describe('contatos completo', () => {
  it('lista por cursor (mais novo primeiro), com fronteiras no fuso e sem simulação', async () => {
    const r = await chamar(ADM, `/v1/relatorios/contatos?${SET}`)
    expect(r.corpo.itens.map((i: any) => i.nome)).toEqual(['Contato 4', 'Contato 3', 'Contato 2', 'Contato 1', 'Contato 7'])
    expect(r.corpo.proximoCursor).toBeNull()
    const c1 = r.corpo.itens.find((i: any) => i.nome === 'Contato 1')
    expect(c1).toMatchObject({ telefone: '+5511999990001', tipoPessoa: 'cpf', uf: 'SP', cidade: 'Campinas', origem: 'Instagram', vendedor: 'Vera Vendedora',
      filial: 'Filial X', formulario: 'LP Verão', convertido: true, pedidos: 2, valorCentavos: 28000, qualificacao: 'novo' })
  })
  it('páginas por cursor não repetem nem pulam', async () => {
    const p1 = await chamar(ADM, `/v1/relatorios/contatos?${SET}&limite=2`)
    const p2 = await chamar(ADM, `/v1/relatorios/contatos?${SET}&limite=2&cursor=${p1.corpo.proximoCursor}`)
    const p3 = await chamar(ADM, `/v1/relatorios/contatos?${SET}&limite=2&cursor=${p2.corpo.proximoCursor}`)
    expect([...p1.corpo.itens, ...p2.corpo.itens, ...p3.corpo.itens].map((i: any) => i.nome))
      .toEqual(['Contato 4', 'Contato 3', 'Contato 2', 'Contato 1', 'Contato 7'])
    expect(p3.corpo.proximoCursor).toBeNull()
  })
  it('filtros extras combinam (E)', async () => {
    const nomes = async (q: string) => (await chamar(ADM, `/v1/relatorios/contatos?${SET}&${q}`)).corpo.itens.map((i: any) => i.nome).sort()
    expect(await nomes('tipoPessoa=cpf')).toEqual(['Contato 1', 'Contato 3'])
    expect(await nomes('tipoPessoa=sem')).toEqual(['Contato 4', 'Contato 7'])
    expect(await nomes('uf=sp')).toEqual(['Contato 1', 'Contato 2'])
    expect(await nomes('convertido=sim')).toEqual(['Contato 1', 'Contato 3'])
    expect(await nomes('convertido=nao&vendedorId=' + VA)).toEqual(['Contato 2', 'Contato 7'])
    expect(await nomes('qualificacao=qualificado')).toEqual(['Contato 3'])
    expect(await nomes('origemId=sem-origem&filialId=' + FY)).toEqual(['Contato 3', 'Contato 4'])
    expect(await nomes('formularioId=' + F2)).toEqual(['Contato 3'])
    expect(await nomes('busca=contato 7')).toEqual(['Contato 7'])
    expect(await nomes('busca=%25%25')).toEqual([])
  })
  it('escopo: vendedor só os dele', async () => {
    const r = await chamar(VA, `/v1/relatorios/contatos?${SET}`)
    expect(r.corpo.itens.map((i: any) => i.nome).sort()).toEqual(['Contato 1', 'Contato 2', 'Contato 7'])
  })
  it('CSV: cabeçalho, neutraliza fórmula, sem documento, x-truncado=false', async () => {
    await dono`UPDATE contato SET nome = '=HYPERLINK("x")' WHERE tenant_id = ${T} AND id = ${c(7)}`
    const r = await chamar(ADM, `/v1/relatorios/contatos.csv?${SET}&convertido=nao`)
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toContain('text/csv')
    expect(r.headers['x-truncado']).toBe('false')
    const linhas = r.texto.replace(/^﻿/, '').trim().split('\r\n')
    expect(linhas[0]).toContain('Nome;Telefone;E-mail;Tipo de pessoa;UF;Cidade')
    expect(linhas).toHaveLength(1 + 3)
    expect(r.texto).toContain(`'=HYPERLINK`)
    expect(r.texto).not.toContain('11111111111')
  })
  it('CSV capado em 1000 linhas, com truncado (tenant B tem 1100)', async () => {
    const r = await chamar(BADM, `/v1/relatorios/contatos.csv?${SET}`, B)
    expect(r.status).toBe(200)
    expect(r.headers['x-truncado']).toBe('true')
    expect(r.texto.replace(/^﻿/, '').trim().split('\r\n')).toHaveLength(1001)
  })
  it('CSV respeita o escopo e o filtro inválido → 422', async () => {
    const r = await chamar(VB, `/v1/relatorios/contatos.csv?${SET}`)
    expect(r.texto.replace(/^﻿/, '').trim().split('\r\n')).toHaveLength(1 + 2)
    expect((await chamar(ADM, `/v1/relatorios/contatos.csv?${SET}&tipoPessoa=x`)).status).toBe(422)
  })
})

describe('raio-x', () => {
  it('por formulário', async () => {
    const r = await chamar(ADM, `/v1/relatorios/raio-x/formulario/${F1}?${SET}`)
    expect(r.corpo).toMatchObject({ eixo: 'formulario', rotulo: 'LP Verão' })
    expect(r.corpo.cartoes).toEqual({ contatos: 1, convertidos: 1, taxa: 1, pedidos: 2, valorCentavos: 28000, ticketMedioCentavos: 14000, respostas: 2, tarefasConcluidas: null })
    expect(r.corpo.porDia).toHaveLength(30)
    expect(r.corpo.origens[0]).toMatchObject({ rotulo: 'Instagram', contatos: 1 })
  })
  it('por vendedor e por filial', async () => {
    const v = await chamar(ADM, `/v1/relatorios/raio-x/vendedor/${VA}?${SET}`)
    expect(v.corpo.cartoes).toMatchObject({ contatos: 3, convertidos: 1, valorCentavos: 28000, tarefasConcluidas: 2, respostas: null })
    expect(v.corpo.ufs.map((g: any) => [g.rotulo, g.contatos])).toEqual([['SP', 2], ['Sem UF', 1]])
    expect(v.corpo.qualificacao.map((g: any) => [g.rotulo, g.contatos])).toEqual([['Novo', 3]])
    const f = await chamar(ADM, `/v1/relatorios/raio-x/filial/${FY}?${SET}`)
    expect(f.corpo).toMatchObject({ rotulo: 'Filial Y' })
    expect(f.corpo.cartoes).toMatchObject({ contatos: 2, convertidos: 1, valorCentavos: 7000 })
  })
  it('formulário inexistente → 404 (não 200 zerado)', async () => {
    const r = await chamar(ADM, `/v1/relatorios/raio-x/formulario/${id('dddd', 99)}?${SET}`)
    expect([r.status, r.corpo.erro]).toEqual([404, 'relatorio.nao_encontrado'])
  })
  it('escopo e tenant: vendedor não vê o raio-x do colega; id de outro tenant → 404', async () => {
    expect((await chamar(VA, `/v1/relatorios/raio-x/vendedor/${VB}?${SET}`)).status).toBe(404)
    expect((await chamar(VA, `/v1/relatorios/raio-x/vendedor/${VA}?${SET}`)).corpo.cartoes.contatos).toBe(3)
    expect((await chamar(GX, `/v1/relatorios/raio-x/filial/${FY}?${SET}`)).status).toBe(404)
    expect((await chamar(ADM, `/v1/relatorios/raio-x/vendedor/${BADM}?${SET}`)).corpo.erro).toBe('relatorio.nao_encontrado')
  })
})

describe('desempenho do cadastro', () => {
  it('completude, tipo de pessoa, status, origem, canal, UF, cidade e funil', async () => {
    const r = await chamar(ADM, `/v1/relatorios/desempenho?${SET}`)
    expect(r.status).toBe(200)
    expect(r.corpo.contatos).toBe(5)
    const comp = Object.fromEntries(r.corpo.completude.map((x: any) => [x.campo, x.preenchidos]))
    expect(comp).toEqual({ telefone: 1, email: 2, documento: 3, endereco: 3, origem: 1, vendedor: 5 })
    expect(r.corpo.cadastroCompleto).toBe(1) // só o c1 tem os seis campos
    expect(r.corpo.tipoPessoa.map((g: any) => [g.chave, g.contatos])).toEqual([['cpf', 2], ['sem', 2], ['cnpj', 1]])
    expect(r.corpo.qualificacao.map((g: any) => [g.chave, g.contatos])).toEqual([['novo', 4], ['qualificado', 1]])
    expect(r.corpo.uf.map((g: any) => [g.chave, g.contatos])).toEqual([['SP', 2], ['sem-uf', 2], ['RJ', 1]])
    expect(r.corpo.cidade[0]).toMatchObject({ rotulo: 'Campinas / SP', contatos: 2 })
    expect(r.corpo.canal[0]).toMatchObject({ rotulo: 'Sem conversa', contatos: 3 })
    expect(r.corpo.canal.find((g: any) => g.rotulo === 'Zap Loja').contatos).toBe(2)
    expect(r.corpo.origem.find((g: any) => g.rotulo === 'Instagram')).toMatchObject({ contatos: 1, convertidos: 1, valorCentavos: 28000 })
    expect(r.corpo.funil.map((g: any) => [g.rotulo, g.contatos])).toEqual([['Lead', 4], ['Sem etapa', 1]]) // etapa atual = a da oportunidade mais recente
    expect(r.corpo.truncado).toEqual({ origem: false, canal: false, uf: false, cidade: false, funil: false })
  })
  it('top 20 com truncado (tenant B: 22 UFs e 25 cidades)', async () => {
    const r = await chamar(BADM, `/v1/relatorios/desempenho?${SET}`, B)
    expect(r.corpo.uf).toHaveLength(20)
    expect(r.corpo.cidade).toHaveLength(20)
    expect(r.corpo.truncado).toMatchObject({ uf: true, cidade: true, origem: false })
  })
  it('escopo: vendedor mede só a própria carteira', async () => {
    expect((await chamar(VB, `/v1/relatorios/desempenho?${SET}`)).corpo.contatos).toBe(2)
  })
})

describe('motivos de perda e imprimíveis', () => {
  it('motivos no fuso do tenant (fronteiras) e percentuais', async () => {
    const r = await chamar(ADM, `/v1/relatorios/motivos-perda?${SET}`)
    expect(r.corpo.total).toBe(3)
    expect(r.corpo.itens).toEqual([
      { chave: 'preco', rotulo: 'Preço', total: 2, percentual: 0.6667 },
      { chave: 'prazo', rotulo: 'Prazo', total: 1, percentual: 0.3333 },
    ])
    expect(r.corpo.truncado).toBe(false)
  })
  it('imprimíveis trazem funil, origens, motivos e WhatsApp do mesmo período', async () => {
    const r = await chamar(ADM, `/v1/relatorios/imprimiveis?${SET}`)
    expect(r.status).toBe(200)
    expect(r.corpo.funil[0]).toMatchObject({ chave: 'lead-e3', oportunidades: 0 })
    expect(r.corpo.origens.itens.find((i: any) => i.rotulo === 'Instagram').contatos).toBe(1)
    expect(r.corpo.motivosPerda.total).toBe(3)
    expect(r.corpo.whatsapp.cartoes).toBeDefined()
    expect((await chamar(ADM, `/v1/relatorios/imprimiveis?${SET}&limiteMin=0`)).corpo.erro).toBe('relatorio.limite_invalido')
  })
  it('motivos: o vendedor só vê as perdas do que enxerga', async () => {
    const r = await chamar(VB, `/v1/relatorios/motivos-perda?${SET}`)
    expect(r.corpo.total).toBe(1)
  })
})

describe('volume: coorte materializada uma vez por requisição', () => {
  it('20 mil contatos: desempenho e raio-x respondem em poucos segundos', async () => {
    await dono`INSERT INTO contato (tenant_id, id, nome, criado_em)
               SELECT ${B}, gen_random_uuid(), 'Volume ' || n, '2026-07-10T12:00:00Z'::timestamptz + (n || ' seconds')::interval FROM generate_series(1, 20000) n`
    await dono`ANALYZE contato`
    const JUL = 'inicio=2026-07-01&fim=2026-07-31'
    const t0 = Date.now()
    const d = await chamar(BADM, `/v1/relatorios/desempenho?${JUL}`, B)
    const ms = Date.now() - t0
    expect(d.corpo.contatos).toBe(20000)
    console.log(`desempenho com 20 mil contatos: ${ms} ms`)
    expect(ms).toBeLessThan(8000)
    const v = await chamar(BADM, `/v1/relatorios/visao-geral?${JUL}`, B)
    expect(v.corpo.totais.contatos).toBe(20000)
  }, 60_000)
})
