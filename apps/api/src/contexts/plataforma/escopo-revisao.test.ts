import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { normalizarTelefone } from '@geracrm/shared'
import { encerrarBanco } from '../../db/index.js'
import { pluginTenant } from '../../plugins/tenant.js'
import { rotasContatos } from '../crm/rotas-contatos.js'
import { rotasCarteira } from '../crm/rotas-carteira.js'
import { rotasFunil } from '../crm/rotas-funil.js'
import { rotasCrmAvancado } from '../crm/rotas-crm-avancado.js'
import { rotasSequencia } from '../crm/rotas-sequencia.js'
import { rotasLista } from '../crm/rotas-lista.js'
import { rotasFidelidade } from '../crm/rotas-fidelidade.js'
import { rotasFila } from '../atendimento/rotas-fila.js'
import { rotasMensagensLog } from '../atendimento/rotas-mensagens-log.js'
import { rotasAtendimentoKanban } from '../atendimento/rotas-atendimento-kanban.js'
import { rotasMensagens } from '../atendimento/rotas-mensagens.js'
import { rotasAgente } from '../atendimento/agente/rotas-agente.js'
import { rotasSugestao } from '../atendimento/agente/rotas-sugestao.js'
import { rotasPedido } from '../pedido/rotas-pedido.js'
import { rotasBi } from './rotas-bi.js'
import { rotasAuditoria } from './rotas-auditoria.js'

/**
 * REVISÃO DE SEGURANÇA DA RAIA D3 — as rotas que ficaram sem escopo ou sem papel.
 * Banco real, papel da aplicação (RLS). Um tenant com admin (regra estrita):
 *
 *   filiais FX e FY; admin; gestor de FX (gx); vendedora VA (FX); vendedor VB
 *   (FY); vendedor inativo (ina, FX).
 *   contatos: CA (carteira de VA), CB (de VB), CO (órfão).
 *   números: N1 e N3 sem ninguém vinculado ("todos atendem"); N2 só VB.
 *   conversas: CV.a (CA, N1), CV.b (CB, N1), CV.fila (CO, N1, na fila),
 *              CV.fila2 (CO, N2, na fila), CV.filaB (CB, N3, na fila — M7).
 *
 * Nos 404, confere-se também o CÓDIGO `erro` — fora do escopo é indistinguível
 * de inexistente.
 */
const A = 'd3f00000-0000-4000-8000-00000000000a'
const PLANO = 'd3f00000-0001-4000-8000-000000000001'
const MODELO = 'd3f00000-0002-4000-8000-000000000001'
const PV = 'd3f00000-0003-4000-8000-00000000000a'
const FX = 'd3f00000-0004-4000-8000-000000000001'
const FY = 'd3f00000-0004-4000-8000-000000000002'
const U = {
  adm: 'd3f00000-0005-4000-8000-000000000001',
  gx: 'd3f00000-0005-4000-8000-000000000002',
  va: 'd3f00000-0005-4000-8000-000000000004',
  vb: 'd3f00000-0005-4000-8000-000000000005',
  ina: 'd3f00000-0005-4000-8000-000000000007',
}
const C = {
  a: 'd3f00000-0006-4000-8000-000000000001',
  b: 'd3f00000-0006-4000-8000-000000000002',
  o: 'd3f00000-0006-4000-8000-000000000003',
}
const N1 = 'd3f00000-0007-4000-8000-000000000001'
const N2 = 'd3f00000-0007-4000-8000-000000000002'
const N3 = 'd3f00000-0007-4000-8000-000000000003'
const CV = {
  a: 'd3f00000-0008-4000-8000-000000000001',
  b: 'd3f00000-0008-4000-8000-000000000002',
  fila: 'd3f00000-0008-4000-8000-000000000003',
  fila2: 'd3f00000-0008-4000-8000-000000000004',
  filaB: 'd3f00000-0008-4000-8000-000000000005',
}
const AT_B = 'd3f00000-0009-4000-8000-000000000001'
const MSG_ACAO_B = 'd3f00000-000a-4000-8000-000000000001'
const DEC = { a: 'd3f00000-000b-4000-8000-000000000001', b: 'd3f00000-000b-4000-8000-000000000002' }
const SESSAO = { a: 'd3f00000-000c-4000-8000-000000000001', b: 'd3f00000-000c-4000-8000-000000000002' }
const SEQ = 'd3f00000-000d-4000-8000-000000000001'
const LISTA = 'd3f00000-000e-4000-8000-000000000001'
const PEDIDO_FILA_B = 'd3f00000-000f-4000-8000-000000000001'
const OPORT_A = 'd3f00000-0010-4000-8000-000000000001'
const CONEXAO = 'd3f00000-0011-4000-8000-000000000001'

const sub = (k: keyof typeof U) => `d3f-sub-${k}`
const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance

async function pedir(quem: keyof typeof U, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  const headers: Record<string, string> = { 'x-tenant-id': A, 'x-teste-sub': sub(quem) }
  const r = await app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) })
  let corpo: Record<string, unknown> & { itens?: Record<string, unknown>[] } = {}
  try { corpo = r.json() } catch { /* corpo vazio */ }
  return { status: r.statusCode, corpo }
}
const ids = (itens: unknown, campo = 'id') => ((itens ?? []) as Record<string, unknown>[]).map((i) => i[campo] as string).sort()
const donoAtual = async (contato: string) =>
  (await dono<{ usuario_id: string | null }[]>`
    SELECT usuario_id FROM carteira_atribuicao WHERE tenant_id = ${A} AND contato_id = ${contato} AND ate IS NULL`)[0]?.usuario_id ?? null

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await limpar()
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-revisao-d3', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-revisao-d3', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${A}, 'Revisao D3', ${PLANO}, ${PV})`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${A}, ${PV}, ${MODELO}, 'Varejo')`
  })
  await dono`INSERT INTO filial (tenant_id, id, nome) VALUES (${A}, ${FX}, 'Filial X'), (${A}, ${FY}, 'Filial Y')`
  for (const k of Object.keys(U) as (keyof typeof U)[]) {
    await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email, ativo)
               VALUES (${A}, ${U[k]}, ${sub(k)}, ${'Pessoa ' + k}, ${sub(k) + '@d3f.test'}, ${k !== 'ina'})`
  }
  await dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES
    (${A}, ${U.adm}, NULL, 'admin'), (${A}, ${U.gx}, ${FX}, 'gestor'),
    (${A}, ${U.va}, ${FX}, 'vendedor'), (${A}, ${U.vb}, ${FY}, 'vendedor'), (${A}, ${U.ina}, ${FX}, 'vendedor')`
  await dono`INSERT INTO contato (tenant_id, id, nome) VALUES
    (${A}, ${C.a}, 'D3F Alfa'), (${A}, ${C.b}, 'D3F Beta'), (${A}, ${C.o}, 'D3F Orfao')`
  await dono`INSERT INTO carteira_atribuicao (tenant_id, id, contato_id, usuario_id) VALUES
    (${A}, gen_random_uuid(), ${C.a}, ${U.va}), (${A}, gen_random_uuid(), ${C.b}, ${U.vb})`
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES
    (${A}, ${N1}, 'whatsapp_nao_oficial', 'Zap D3F 1', 'conectado'),
    (${A}, ${N2}, 'whatsapp_nao_oficial', 'Zap D3F 2', 'conectado'),
    (${A}, ${N3}, 'whatsapp_nao_oficial', 'Zap D3F 3', 'conectado')`
  await dono`INSERT INTO usuario_canal (tenant_id, usuario_id, canal_id) VALUES (${A}, ${U.vb}, ${N2})`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, ultima_direcao, ultima_mensagem_em) VALUES
    (${A}, ${CV.a}, ${N1}, ${C.a}, 'saliente', now() - interval '5 min'),
    (${A}, ${CV.b}, ${N1}, ${C.b}, 'saliente', now() - interval '4 min'),
    (${A}, ${CV.fila}, ${N1}, ${C.o}, 'entrante', now() - interval '3 min'),
    (${A}, ${CV.fila2}, ${N2}, ${C.o}, 'entrante', now() - interval '2 min'),
    (${A}, ${CV.filaB}, ${N3}, ${C.b}, 'entrante', now() - interval '1 min')`
  // Atendimento do VB na conversa do cliente dele (M1).
  await dono`INSERT INTO atendimento (tenant_id, id, conversa_id, canal_id, protocolo, atendente_id, estado, assumido_em)
             VALUES (${A}, ${AT_B}, ${CV.b}, ${N1}, 990001, ${U.vb}, 'em_atendimento', now())`
  // Mensagens enviadas (A2) e uma mensagem de AÇÃO pendente na conversa do VB (M1).
  await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, status, criado_em) VALUES
    (${A}, gen_random_uuid(), ${CV.a}, 'saliente', 'texto', ${JSON.stringify({ texto: 'para alfa' })}::text::jsonb, 'enviada', now() - interval '2 min'),
    (${A}, gen_random_uuid(), ${CV.b}, 'saliente', 'texto', ${JSON.stringify({ texto: 'para beta' })}::text::jsonb, 'enviada', now() - interval '1 min'),
    (${A}, ${MSG_ACAO_B}, ${CV.b}, 'saliente', 'acao', ${JSON.stringify({ estado: 'pendente', opcoes: [{ id: 'confirmar' }, { id: 'recusar' }] })}::text::jsonb, NULL, now())`
  // Sessões e decisões do agente (A3, M1).
  await dono`INSERT INTO agente_sessao (tenant_id, id, conversa_id, canal_id) VALUES
    (${A}, ${SESSAO.a}, ${CV.a}, ${N1}), (${A}, ${SESSAO.b}, ${CV.b}, ${N1})`
  for (const [id, cv] of [[DEC.a, CV.a], [DEC.b, CV.b]] as const) {
    await dono`INSERT INTO agente_decisao (tenant_id, id, conversa_id, canal_id, modo, desfecho, resposta, ferramentas, criado_em)
               VALUES (${A}, ${id}, ${cv}, ${N1}, 'assistido', 'sugeriu',
                       ${JSON.stringify({ mensagens: ['oi'], confianca: 0.9 })}::text::jsonb,
                       ${JSON.stringify([{ nome: 'catalogo_buscar', entrada: { q: 'camisa' }, saida: { preco: 1990 }, ms: 3 }])}::text::jsonb,
                       clock_timestamp())`
  }
  // Pedido que nasceu na conversa da fila do cliente do VB (M7).
  await dono`INSERT INTO pedido (tenant_id, id, contato_id, conversa_id, estado) VALUES (${A}, ${PEDIDO_FILA_B}, ${C.b}, ${CV.filaB}, 'rascunho')`
  // Sequência e lista (M2).
  await dono`INSERT INTO sequencia (tenant_id, id, nome) VALUES (${A}, ${SEQ}, 'Pós-venda')`
  await dono`INSERT INTO sequencia_passo (tenant_id, sequencia_id, seq, offset_dias, titulo) VALUES (${A}, ${SEQ}, 1, 1, 'Ligar')`
  await dono`INSERT INTO lista (tenant_id, id, nome) VALUES (${A}, ${LISTA}, 'VIP')`
  await dono`INSERT INTO lista_membro (tenant_id, lista_id, contato_id) VALUES (${A}, ${LISTA}, ${C.a}), (${A}, ${LISTA}, ${C.b})`
  // BI e fidelidade (M4).
  await dono`INSERT INTO venda (tenant_id, id, contato_id, usuario_id, ocorrida_em, valor_centavos) VALUES
    (${A}, gen_random_uuid(), ${C.a}, ${U.va}, now() - interval '2 days', 10000),
    (${A}, gen_random_uuid(), ${C.b}, ${U.vb}, now() - interval '2 days', 20000)`
  await dono`INSERT INTO conexao_erp (tenant_id, id, conector, nome_amigavel, capacidades, estado)
             VALUES (${A}, ${CONEXAO}, 'geracloud', 'ERP D3F', ${JSON.stringify({ fidelidade: true })}::text::jsonb, 'ativa')`
  await dono`INSERT INTO fidelidade_saldo (tenant_id, contato_id, saldo, unidade) VALUES
    (${A}, ${C.a}, 1000, 'centavos'), (${A}, ${C.b}, 2000, 'centavos')`

  app = Fastify()
  await app.register(pluginTenant)
  app.addHook('onRequest', async (req) => {
    const s = req.headers['x-teste-sub']
    if (typeof s === 'string') { req.usuarioSub = s; req.usuarioEmail = `${s}@d3f.test` }
  })
  for (const r of [rotasContatos, rotasCarteira, rotasFunil, rotasCrmAvancado, rotasSequencia, rotasLista, rotasFidelidade,
    rotasFila, rotasMensagensLog, rotasAtendimentoKanban, rotasMensagens, rotasAgente, rotasSugestao, rotasPedido, rotasBi, rotasAuditoria]) {
    await app.register(r)
  }
  await app.ready()

  await pedir('adm', 'GET', '/v1/funil/etapas') // as etapas nascem na 1ª leitura
  const [e] = await dono<{ id: string }[]>`SELECT id FROM funil_etapa WHERE tenant_id = ${A} AND tipo = 'aberto' AND ativo ORDER BY ordem LIMIT 1`
  await dono`INSERT INTO oportunidade (tenant_id, id, contato_id, etapa_id, posicao) VALUES (${A}, ${OPORT_A}, ${C.a}, ${e!.id}, 1)`
})

async function limpar(): Promise<void> {
  const t = A
  for (const tabela of ['auditoria', 'outbox', 'atendimento_etapa_historico', 'mensagem', 'agente_decisao', 'agente_sessao',
    'oportunidade_etapa_historico', 'oportunidade', 'funil_etapa', 'pedido', 'tarefa', 'atendimento', 'atendimento_etapa',
    'conversa_leitura', 'conversa', 'usuario_canal', 'canal_conectado', 'venda', 'fidelidade_saldo', 'conexao_erp',
    'lista_membro', 'lista', 'sequencia_passo', 'sequencia', 'carteira_atribuicao', 'contato_documento', 'contato_endereco',
    'contato_telefone', 'contato', 'usuario_filial', 'usuario', 'filial']) {
    await dono`DELETE FROM ${dono(tabela)} WHERE tenant_id = ${t}`
  }
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
  await dono`DELETE FROM tenant WHERE id = ${t}`
}

afterAll(async () => {
  await limpar()
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app?.close(); await encerrarBanco(); await dono.end()
})

describe('A1 — CRM avançado: totais e colunas no escopo', () => {
  it('vendedora conta e lista só a própria carteira; admin vê a base', async () => {
    const col = await pedir('va', 'GET', '/v1/crm-avancado/colunas')
    const total = (col.corpo.colunas as { total: number }[]).reduce((s, c) => s + c.total, 0)
    expect(total).toBe(1)
    expect(ids((await pedir('va', 'GET', '/v1/crm-avancado/coluna/leads')).corpo.itens, 'contatoId')).toEqual([C.a])
    const adm = await pedir('adm', 'GET', '/v1/crm-avancado/colunas')
    expect((adm.corpo.colunas as { total: number }[]).reduce((s, c) => s + c.total, 0)).toBe(3)
  })
})

describe('A2 — mensagens enviadas no escopo', () => {
  it('vendedora vê só as mensagens das conversas que enxerga', async () => {
    const r = await pedir('va', 'GET', '/v1/mensagens-enviadas')
    expect((r.corpo.itens ?? []).map((i) => i.contatoId)).toEqual([C.a])
    expect(new Set((await pedir('adm', 'GET', '/v1/mensagens-enviadas')).corpo.itens!.map((i) => i.contatoId))).toEqual(new Set([C.a, C.b]))
  })
})

describe('A3 — sessões e decisões do agente no escopo', () => {
  it('sessões: só das conversas visíveis', async () => {
    expect(ids((await pedir('va', 'GET', '/v1/agente/sessoes')).corpo.itens)).toEqual([SESSAO.a])
    expect(ids((await pedir('adm', 'GET', '/v1/agente/sessoes')).corpo.itens)).toEqual([SESSAO.a, SESSAO.b].sort())
  })

  it('decisões: conversaId fora do escopo → 404; a lista só traz as visíveis; entrada/saída de ferramenta só para gestão', async () => {
    const fora = await pedir('va', 'GET', `/v1/agente/decisoes?conversaId=${CV.b}`)
    expect(fora.status).toBe(404)
    expect(fora.corpo.erro).toBe('conversa.nao_encontrada')
    const minhas = await pedir('va', 'GET', '/v1/agente/decisoes')
    expect(ids(minhas.corpo.itens)).toEqual([DEC.a])
    expect(minhas.corpo.itens![0]!.ferramentas).toEqual([{ nome: 'catalogo_buscar' }])
    const gestao = await pedir('adm', 'GET', `/v1/agente/decisoes?conversaId=${CV.a}`)
    expect((gestao.corpo.itens![0]!.ferramentas as { saida?: unknown }[])[0]!.saida).toEqual({ preco: 1990 })
  })
})

describe('M1 — ações por id de atendimento, mensagem e decisão', () => {
  it('mover card, resolver ação e descartar sugestão da conversa alheia → 404 tipificado, sem efeito', async () => {
    const [etapa] = await dono<{ id: string }[]>`
      INSERT INTO atendimento_etapa (tenant_id, id, chave, nome, tipo, ordem, ativo)
      VALUES (${A}, gen_random_uuid(), 'em_curso_d3f', 'Em curso', 'atendimento', 1, true) RETURNING id`
    const mover = await pedir('va', 'POST', `/v1/atendimento-kanban/${AT_B}/mover`, { etapaId: etapa!.id })
    expect(mover.status).toBe(404)
    expect(mover.corpo.erro).toBe('atendimento.nao_encontrado')
    const [at] = await dono<{ etapa_id: string | null }[]>`SELECT etapa_id FROM atendimento WHERE tenant_id = ${A} AND id = ${AT_B}`
    expect(at!.etapa_id).toBeNull()

    const resolver = await pedir('va', 'POST', `/v1/mensagens/${MSG_ACAO_B}/resolver`, { opcaoId: 'confirmar' })
    expect(resolver.status).toBe(404)
    expect(resolver.corpo.erro).toBe('mensagem.nao_encontrada')
    const [m] = await dono<{ estado: string }[]>`SELECT conteudo->>'estado' AS estado FROM mensagem WHERE tenant_id = ${A} AND id = ${MSG_ACAO_B}`
    expect(m!.estado).toBe('pendente')

    const descartar = await pedir('va', 'POST', `/v1/agente/sugestoes/${DEC.b}/descartar`, {})
    expect(descartar.status).toBe(404)
    expect(descartar.corpo.erro).toBe('sugestao.nao_encontrada')
    const [d] = await dono<{ sugestao_estado: string | null }[]>`SELECT sugestao_estado FROM agente_decisao WHERE tenant_id = ${A} AND id = ${DEC.b}`
    expect(d!.sugestao_estado).toBeNull()
    // A própria funciona.
    expect((await pedir('va', 'POST', `/v1/agente/sugestoes/${DEC.a}/descartar`, {})).status).toBe(200)
  })
})

describe('M2 — sequências e listas', () => {
  it('aplicar sequência em contato alheio → mesmo 422 de inexistente, nenhuma tarefa', async () => {
    const r = await pedir('va', 'POST', `/v1/sequencias/${SEQ}/aplicar`, { contatoId: C.b })
    expect(r.status).toBe(422)
    expect(r.corpo.erro).toBe('sequencia.contato_invalido')
    const [n] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM tarefa WHERE tenant_id = ${A} AND contato_id = ${C.b}`
    expect(n!.n).toBe(0)
  })

  it('membros: lista só os do escopo; adicionar contato alheio → 422 de inexistente', async () => {
    expect(ids((await pedir('va', 'GET', `/v1/listas/${LISTA}/membros`)).corpo.itens)).toEqual([C.a])
    expect(ids((await pedir('adm', 'GET', `/v1/listas/${LISTA}/membros`)).corpo.itens)).toEqual([C.a, C.b].sort())
    const add = await pedir('va', 'POST', `/v1/listas/${LISTA}/membros`, { contatoId: C.o })
    expect(add.status).toBe(422)
    expect(add.corpo.erro).toBe('lista.contato_invalido')
    const [n] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM lista_membro WHERE tenant_id = ${A} AND contato_id = ${C.o}`
    expect(n!.n).toBe(0)
  })
})

describe('M4/M5 — BI, fidelidade, auditoria e importação', () => {
  it('BI: rankings com nome só do escopo', async () => {
    const r = await pedir('va', 'GET', '/v1/bi?dias=30')
    expect(ids(r.corpo.topClientes, 'contatoId')).toEqual([C.a])
    expect(ids(r.corpo.porVendedor, 'usuarioId')).toEqual([U.va])
    const adm = await pedir('adm', 'GET', '/v1/bi?dias=30')
    expect(ids(adm.corpo.topClientes, 'contatoId')).toEqual([C.a, C.b].sort())
  })

  it('fidelidade: ranking de saldos só do escopo', async () => {
    expect(ids((await pedir('va', 'GET', '/v1/fidelidade')).corpo.topSaldos, 'contatoId')).toEqual([C.a])
    expect(ids((await pedir('adm', 'GET', '/v1/fidelidade')).corpo.topSaldos, 'contatoId')).toEqual([C.a, C.b].sort())
  })

  it('auditoria exige gestão (gestor/admin); vendedor → 403', async () => {
    const v = await pedir('va', 'GET', '/v1/auditoria')
    expect(v.status).toBe(403)
    expect(v.corpo.erro).toBe('acesso.papel_insuficiente')
    expect((await pedir('gx', 'GET', '/v1/auditoria')).status).toBe(200)
  })

  it('importar contatos exige gestão; vendedor → 403', async () => {
    const v = await pedir('va', 'POST', '/v1/contatos/importar', { csv: 'nome,telefone\nX,11987654321' })
    expect(v.status).toBe(403)
    expect(v.corpo.erro).toBe('acesso.papel_insuficiente')
    expect((await pedir('gx', 'POST', '/v1/contatos/importar', { csv: '' })).status).toBe(422) // passou do papel
  })
})

describe('C2 — carteira e transferência só pela gestão, destino no escopo', () => {
  it('vendedora não atribui nem transfere (403); a própria carteira ela SOLTA', async () => {
    const t = await pedir('va', 'POST', `/v1/contatos/${C.a}/carteira`, { usuarioId: U.vb })
    expect(t.status).toBe(403)
    expect(t.corpo.erro).toBe('acesso.papel_insuficiente')
    expect(await donoAtual(C.a)).toBe(U.va)
    expect((await pedir('va', 'DELETE', `/v1/contatos/${C.a}/carteira`)).status).toBe(200)
    expect(await donoAtual(C.a)).toBeNull()
    expect((await pedir('adm', 'POST', `/v1/contatos/${C.a}/carteira`, { usuarioId: U.va })).status).toBe(200)
    expect(await donoAtual(C.a)).toBe(U.va)
  })

  it('gestor de FX só transfere para alguém de FX (422 para FY); inativo não é destino', async () => {
    const paraY = await pedir('gx', 'POST', `/v1/contatos/${C.a}/carteira`, { usuarioId: U.vb })
    expect(paraY.status).toBe(422)
    expect(paraY.corpo.erro).toBe('carteira.usuario_invalido')
    const paraInativo = await pedir('gx', 'POST', `/v1/contatos/${C.o}/carteira`, { usuarioId: U.ina })
    expect(paraInativo.corpo.erro).toBe('carteira.usuario_invalido')
    expect(await donoAtual(C.a)).toBe(U.va)
    // Funil: mesma regra do destino.
    const funil = await pedir('gx', 'POST', `/v1/funil/oportunidades/${OPORT_A}/transferir`, { usuarioId: U.vb, motivo: 'teste' })
    expect(funil.status).toBe(422)
    expect(funil.corpo.erro).toBe('carteira.usuario_invalido')
    expect(await donoAtual(C.a)).toBe(U.va)
  })
})

describe('BAIXA — filial desativada e dedupe fora do escopo', () => {
  it('vínculo em filial desativada não vale: o gestor de FX perde a filial enquanto ela estiver inativa', async () => {
    expect((await pedir('gx', 'GET', `/v1/contatos/${C.a}`)).status).toBe(200)
    await dono`UPDATE filial SET ativa = false WHERE tenant_id = ${A} AND id = ${FX}`
    try {
      const r = await pedir('gx', 'GET', `/v1/contatos/${C.a}`)
      expect(r.status).toBe(404)
      expect(r.corpo.erro).toBe('contato.nao_encontrado')
    } finally {
      await dono`UPDATE filial SET ativa = true WHERE tenant_id = ${A} AND id = ${FX}`
    }
  })

  it('POST /v1/contatos com telefone de contato fora do escopo → 409 sem id', async () => {
    const tel = normalizarTelefone('11912345678')!
    await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
               VALUES (${A}, ${C.b}, 1, ${tel.e164}, ${tel.chaveBloqueio}, true, true, 'manual')`
    const r = await pedir('va', 'POST', '/v1/contatos', { nome: 'Tentativa', telefone: '11912345678' })
    expect(r.status).toBe(409)
    expect(r.corpo.erro).toBe('contato.ja_existe')
    expect(r.corpo.id).toBeUndefined()
    // Quem enxerga recebe o existente, como antes.
    expect((await pedir('adm', 'POST', '/v1/contatos', { nome: 'Tentativa', telefone: '11912345678' })).corpo.id).toBe(C.b)
  })
})

describe('C2 — assumir exige a conversa no escopo (e a fila segue funcionando)', () => {
  it('conversa do cliente alheio e fila de número que ela não atende → 404, sem atendimento', async () => {
    const outroNumero = await pedir('va', 'POST', `/v1/conversas/${CV.fila2}/assumir`, {})
    expect(outroNumero.status).toBe(404)
    expect(outroNumero.corpo.erro).toBe('conversa.nao_encontrada')
    // Conversa do cliente do VB SEM atendimento aberto: invisível para VA.
    await dono`UPDATE atendimento SET estado = 'encerrado', encerrado_em = now() WHERE tenant_id = ${A} AND id = ${AT_B}`
    const doColega = await pedir('va', 'POST', `/v1/conversas/${CV.b}/assumir`, {})
    expect(doColega.status).toBe(404)
    expect(doColega.corpo.erro).toBe('conversa.nao_encontrada')
    const [n] = await dono<{ n: number }[]>`
      SELECT count(*)::int AS n FROM atendimento WHERE tenant_id = ${A} AND conversa_id IN (${CV.b}, ${CV.fila2}) AND estado <> 'encerrado'`
    expect(n!.n).toBe(0)
  })

  it('usuário inativo não assume nem a fila', async () => {
    const r = await pedir('ina', 'POST', `/v1/conversas/${CV.fila}/assumir`, {})
    expect(r.status).toBe(404)
    expect(r.corpo.erro).toBe('conversa.nao_encontrada')
  })

  it('a vendedora assume da FILA do número que atende (positivo); o VB assume a fila do número dele', async () => {
    expect((await pedir('va', 'POST', `/v1/conversas/${CV.fila}/assumir`, {})).status).toBe(201)
    expect((await pedir('vb', 'POST', `/v1/conversas/${CV.fila2}/assumir`, {})).status).toBe(201)
  })
})

describe('M7 — régua carteira: a fila não mostra o cliente de outro dono até a reatribuição liberar', () => {
  it('antes da liberação: VA não vê/assume a conversa nem o pedido dela; VB (dono) vê', async () => {
    const r = await pedir('va', 'POST', `/v1/conversas/${CV.filaB}/assumir`, {})
    expect(r.status).toBe(404)
    expect(r.corpo.erro).toBe('conversa.nao_encontrada')
    const p = await pedir('va', 'GET', `/v1/pedidos/${PEDIDO_FILA_B}`)
    expect(p.status).toBe(404)
    expect(p.corpo.erro).toBe('pedido.nao_encontrado')
    expect((await pedir('vb', 'GET', `/v1/pedidos/${PEDIDO_FILA_B}`)).status).toBe(200)
  })

  it('com a reatribuição do SLA LIBERADA, a fila volta a mostrar o cliente — e VA assume', async () => {
    await dono`INSERT INTO atendimento (tenant_id, id, conversa_id, canal_id, protocolo, estado, responsavel_id,
                                        reatribuicao_liberada_em, sla_inicio_em, sla_vence_em)
               VALUES (${A}, gen_random_uuid(), ${CV.filaB}, ${N3}, 990002, 'na_fila', ${U.vb},
                       now() - interval '1 min', now() - interval '30 min', now() - interval '10 min')`
    expect((await pedir('va', 'GET', `/v1/pedidos/${PEDIDO_FILA_B}`)).status).toBe(200)
    expect((await pedir('va', 'POST', `/v1/conversas/${CV.filaB}/assumir`, {})).status).toBe(201)
  })
})
