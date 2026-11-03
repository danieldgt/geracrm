import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { encerrarBanco } from '../../db/index.js'
import { pluginTenant } from '../../plugins/tenant.js'
import { rotasContatos } from '../crm/rotas-contatos.js'
import { rotasCarteira } from '../crm/rotas-carteira.js'
import { rotasTarefa } from '../crm/rotas-tarefa.js'
import { rotasFunil } from '../crm/rotas-funil.js'
import { rotasLeads } from '../crm/rotas-leads.js'
import { rotasConversas } from '../atendimento/rotas-conversas.js'
import { rotasFila } from '../atendimento/rotas-fila.js'
import { rotasPedido } from '../pedido/rotas-pedido.js'
import { rotasAtendimentoKanban } from '../atendimento/rotas-atendimento-kanban.js'
import { rotasMensagens } from '../atendimento/rotas-mensagens.js'
import { rotasDevolucao } from '../atendimento/rotas-devolucao.js'
import { rotasEtiquetas } from '../crm/rotas-etiquetas.js'

/**
 * ESCOPO NAS ROTAS (D3) — banco real, papel da aplicação (RLS), DOIS tenants.
 *
 *   Tenant A (com admin → regra estrita):
 *     filiais FX e FY; admin; gestor de FX; supervisor de todas; vendedora VA
 *     (FX); vendedor VB (FY); sem papel; inativo.
 *     contatos: CA (carteira de VA), CB (de VB), CO (órfão sem filial),
 *     COY (órfão com filial FY).
 *   Tenant B (sem admin → modo fundador).
 *
 * Identidade: o header `x-teste-sub` vira `usuarioSub` (como o Cognito faria);
 * `x-teste-staff` simula a sessão de staff.
 */
const A = 'd3e00000-0000-4000-8000-00000000000a'
const B = 'd3e00000-0000-4000-8000-00000000000b'
const PLANO = 'd3e00000-0001-4000-8000-000000000001'
const MODELO = 'd3e00000-0002-4000-8000-000000000001'
const PV_A = 'd3e00000-0003-4000-8000-00000000000a'
const PV_B = 'd3e00000-0003-4000-8000-00000000000b'
const FX = 'd3e00000-0004-4000-8000-000000000001'
const FY = 'd3e00000-0004-4000-8000-000000000002'
const U = {
  adm: 'd3e00000-0005-4000-8000-000000000001',
  gx: 'd3e00000-0005-4000-8000-000000000002',
  sup: 'd3e00000-0005-4000-8000-000000000003',
  va: 'd3e00000-0005-4000-8000-000000000004',
  vb: 'd3e00000-0005-4000-8000-000000000005',
  sem: 'd3e00000-0005-4000-8000-000000000006',
  ina: 'd3e00000-0005-4000-8000-000000000007',
  bx: 'd3e00000-0005-4000-8000-000000000008',
  by: 'd3e00000-0005-4000-8000-000000000009',
}
const C = {
  a: 'd3e00000-0006-4000-8000-000000000001',
  b: 'd3e00000-0006-4000-8000-000000000002',
  o: 'd3e00000-0006-4000-8000-000000000003',
  oy: 'd3e00000-0006-4000-8000-000000000004',
  t2: 'd3e00000-0006-4000-8000-000000000005',
  t2b: 'd3e00000-0006-4000-8000-000000000006',
}
const CANAL1 = 'd3e00000-0007-4000-8000-000000000001'
const CANAL2 = 'd3e00000-0007-4000-8000-000000000002'
const CV = {
  a: 'd3e00000-0008-4000-8000-000000000001',
  b: 'd3e00000-0008-4000-8000-000000000002',
  fila: 'd3e00000-0008-4000-8000-000000000003',
  fila2: 'd3e00000-0008-4000-8000-000000000004',
}
const T = {
  a: 'd3e00000-0009-4000-8000-000000000001',
  b: 'd3e00000-0009-4000-8000-000000000002',
  livre: 'd3e00000-0009-4000-8000-000000000003',
  livreB: 'd3e00000-0009-4000-8000-000000000004',
}
const P = { a: 'd3e00000-000a-4000-8000-000000000001', b: 'd3e00000-000a-4000-8000-000000000002' }
const O = { a: 'd3e00000-000b-4000-8000-000000000001', b: 'd3e00000-000b-4000-8000-000000000002' }

const sub = (k: keyof typeof U) => `d3e-sub-${k}`
const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance

async function pedir(quem: keyof typeof U | 'staff', method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  const tenant = quem === 'bx' || quem === 'by' ? B : A
  const headers: Record<string, string> = { 'x-tenant-id': tenant, 'x-teste-sub': quem === 'staff' ? 'd3e-sub-staff' : sub(quem) }
  if (quem === 'staff') headers['x-teste-staff'] = '1'
  const r = await app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) })
  return { status: r.statusCode, corpo: r.json() as Record<string, unknown> & { itens?: Record<string, unknown>[] } }
}
const ids = (corpo: { itens?: Record<string, unknown>[] }, campo = 'id') => (corpo.itens ?? []).map((i) => i[campo] as string).sort()

let etapaFunil = ''

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await limpar() // resto de uma rodada interrompida
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-escopo-d3', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-escopo-d3', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[A, PV_A, 'Escopo A'], [B, PV_B, 'Escopo B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await dono`INSERT INTO filial (tenant_id, id, nome) VALUES (${A}, ${FX}, 'Filial X'), (${A}, ${FY}, 'Filial Y')`
  for (const k of Object.keys(U) as (keyof typeof U)[]) {
    const t = k === 'bx' || k === 'by' ? B : A
    await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email, ativo)
               VALUES (${t}, ${U[k]}, ${sub(k)}, ${'Pessoa ' + k}, ${sub(k) + '@d3.test'}, ${k !== 'ina'})`
  }
  const vinc = (u: string, f: string | null, p: string) =>
    dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES (${A}, ${u}, ${f}, ${p})`
  await vinc(U.adm, null, 'admin')
  await vinc(U.gx, FX, 'gestor')
  await vinc(U.sup, null, 'supervisor')
  await vinc(U.va, FX, 'vendedor')
  await vinc(U.vb, FY, 'vendedor')
  await vinc(U.ina, FX, 'vendedor')

  await dono`INSERT INTO contato (tenant_id, id, nome, filial_id) VALUES
    (${A}, ${C.a}, 'D3 Cliente Alfa', NULL), (${A}, ${C.b}, 'D3 Cliente Beta', NULL),
    (${A}, ${C.o}, 'D3 Cliente Orfao', NULL), (${A}, ${C.oy}, 'D3 Cliente Orfao Y', ${FY}),
    (${B}, ${C.t2}, 'D3 Cliente B1', NULL), (${B}, ${C.t2b}, 'D3 Cliente B2', NULL)`
  await dono`INSERT INTO carteira_atribuicao (tenant_id, id, contato_id, usuario_id) VALUES
    (${A}, gen_random_uuid(), ${C.a}, ${U.va}), (${A}, gen_random_uuid(), ${C.b}, ${U.vb}),
    (${B}, gen_random_uuid(), ${C.t2}, ${U.by})`
  // Venda antiga → os dois entram na Fila do Dia (urgência = dias/30 > 0.9).
  for (const c of [C.a, C.b]) {
    await dono`INSERT INTO venda (tenant_id, id, contato_id, ocorrida_em, valor_centavos)
               VALUES (${A}, gen_random_uuid(), ${c}, now() - interval '90 days', 10000)`
  }
  await dono`SELECT atualizar_metricas_contato()`

  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES
    (${A}, ${CANAL1}, 'whatsapp_nao_oficial', 'Zap D3 1', 'conectado'),
    (${A}, ${CANAL2}, 'whatsapp_nao_oficial', 'Zap D3 2', 'conectado')`
  // CANAL2 tem gente vinculada (só VB); CANAL1 não tem ninguém → "todos atendem".
  await dono`INSERT INTO usuario_canal (tenant_id, usuario_id, canal_id) VALUES (${A}, ${U.vb}, ${CANAL2})`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, ultima_direcao, ultima_mensagem_em) VALUES
    (${A}, ${CV.a}, ${CANAL1}, ${C.a}, 'saliente', now() - interval '4 min'),
    (${A}, ${CV.b}, ${CANAL1}, ${C.b}, 'saliente', now() - interval '3 min'),
    (${A}, ${CV.fila}, ${CANAL1}, ${C.o}, 'entrante', now() - interval '2 min'),
    (${A}, ${CV.fila2}, ${CANAL2}, ${C.oy}, 'entrante', now() - interval '1 min')`

  await dono`INSERT INTO tarefa (tenant_id, id, contato_id, responsavel_id, titulo, vence_em) VALUES
    (${A}, ${T.a}, ${C.a}, ${U.va}, 'Ligar Alfa', now() + interval '1 day'),
    (${A}, ${T.b}, ${C.b}, ${U.vb}, 'Ligar Beta', now() + interval '1 day'),
    (${A}, ${T.livre}, NULL, NULL, 'Tarefa de ninguém', now() + interval '2 day'),
    (${A}, ${T.livreB}, ${C.b}, NULL, 'Sem dono, cliente Beta', now() + interval '2 day')`
  await dono`INSERT INTO pedido (tenant_id, id, contato_id, estado) VALUES
    (${A}, ${P.a}, ${C.a}, 'rascunho'), (${A}, ${P.b}, ${C.b}, 'rascunho')`

  app = Fastify()
  await app.register(pluginTenant)
  app.addHook('onRequest', async (req) => {
    const s = req.headers['x-teste-sub']
    if (typeof s === 'string') { req.usuarioSub = s; req.usuarioEmail = `${s}@d3.test` }
    if (req.headers['x-teste-staff'] === '1') req.atorStaff = true
  })
  for (const r of [rotasContatos, rotasCarteira, rotasTarefa, rotasFunil, rotasLeads, rotasConversas, rotasFila, rotasPedido, rotasAtendimentoKanban, rotasMensagens, rotasDevolucao, rotasEtiquetas]) {
    await app.register(r)
  }
  await app.ready()

  // Etapas do funil nascem na 1ª leitura; as oportunidades vão para a 1ª aberta.
  await pedir('adm', 'GET', '/v1/funil/etapas')
  const [e] = await dono<{ id: string }[]>`SELECT id FROM funil_etapa WHERE tenant_id = ${A} AND tipo = 'aberto' AND ativo ORDER BY ordem LIMIT 1`
  etapaFunil = e!.id
  await dono`INSERT INTO oportunidade (tenant_id, id, contato_id, etapa_id, posicao) VALUES
    (${A}, ${O.a}, ${C.a}, ${etapaFunil}, 1), (${A}, ${O.b}, ${C.b}, ${etapaFunil}, 2)`
})

async function limpar(): Promise<void> {
  for (const t of [A, B]) {
    await dono`DELETE FROM auditoria WHERE tenant_id = ${t}`
    await dono`DELETE FROM outbox WHERE tenant_id = ${t}`
    await dono`DELETE FROM atendimento_etapa_historico WHERE tenant_id = ${t}`
    await dono`DELETE FROM mensagem WHERE tenant_id = ${t}`
    await dono`DELETE FROM oportunidade_etapa_historico WHERE tenant_id = ${t}`
    await dono`DELETE FROM oportunidade WHERE tenant_id = ${t}`
    await dono`DELETE FROM funil_etapa WHERE tenant_id = ${t}`
    await dono`DELETE FROM pedido WHERE tenant_id = ${t}`
    await dono`DELETE FROM tarefa WHERE tenant_id = ${t}`
    await dono`DELETE FROM atendimento WHERE tenant_id = ${t}`
    await dono`DELETE FROM atendimento_etapa WHERE tenant_id = ${t}`
    await dono`DELETE FROM conversa_leitura WHERE tenant_id = ${t}`
    await dono`DELETE FROM conversa WHERE tenant_id = ${t}`
    await dono`DELETE FROM usuario_canal WHERE tenant_id = ${t}`
    await dono`DELETE FROM canal_conectado WHERE tenant_id = ${t}`
    await dono`DELETE FROM venda WHERE tenant_id = ${t}`
    await dono`DELETE FROM carteira_atribuicao WHERE tenant_id = ${t}`
    await dono`DELETE FROM comentario WHERE tenant_id = ${t}`
    await dono`DELETE FROM contato_telefone WHERE tenant_id = ${t}`
    await dono`DELETE FROM contato WHERE tenant_id = ${t}`
    await dono`DELETE FROM usuario_filial WHERE tenant_id = ${t}`
    await dono`DELETE FROM usuario WHERE tenant_id = ${t}`
    await dono`DELETE FROM filial WHERE tenant_id = ${t}`
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
}

afterAll(async () => {
  await limpar()
  await dono`SELECT atualizar_metricas_contato()`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app?.close(); await encerrarBanco(); await dono.end()
})

const TODOS_A = [C.a, C.b, C.o, C.oy].sort()

describe('contatos — lista, busca e ficha', () => {
  it('vendedora vê só a própria carteira; o contato do colega é 404 (não 403)', async () => {
    expect(ids((await pedir('va', 'GET', '/v1/contatos')).corpo)).toEqual([C.a])
    expect(ids((await pedir('vb', 'GET', '/v1/contatos')).corpo)).toEqual([C.b])
    expect((await pedir('va', 'GET', `/v1/contatos/${C.a}`)).status).toBe(200)
    const outro = await pedir('va', 'GET', `/v1/contatos/${C.b}`)
    expect(outro.status).toBe(404)
    expect(outro.corpo.erro).toBe('contato.nao_encontrado')
    expect((await pedir('va', 'GET', `/v1/contatos/${C.o}`)).status).toBe(404)
  })

  it('gestor da filial X vê os clientes dos vendedores de X e os órfãos SEM filial; nunca os de Y', async () => {
    expect(ids((await pedir('gx', 'GET', '/v1/contatos')).corpo)).toEqual([C.a, C.o].sort())
    expect((await pedir('gx', 'GET', `/v1/contatos/${C.b}`)).status).toBe(404)
    expect((await pedir('gx', 'GET', `/v1/contatos/${C.oy}`)).status).toBe(404)
  })

  it('admin, supervisor de todas as filiais e staff veem tudo', async () => {
    for (const quem of ['adm', 'sup', 'staff'] as const) {
      expect(ids((await pedir(quem, 'GET', '/v1/contatos')).corpo)).toEqual(TODOS_A)
      expect((await pedir(quem, 'GET', `/v1/contatos/${C.b}`)).status).toBe(200)
    }
  })

  it('sem papel (fora do modo fundador) não vê nada; inativo também não', async () => {
    expect(ids((await pedir('sem', 'GET', '/v1/contatos')).corpo)).toEqual([])
    expect(ids((await pedir('ina', 'GET', '/v1/contatos')).corpo)).toEqual([])
    expect((await pedir('ina', 'GET', `/v1/contatos/${C.a}`)).status).toBe(404)
  })

  it('busca respeita o escopo', async () => {
    expect(ids((await pedir('va', 'GET', '/v1/contatos/busca?q=D3%20Cliente')).corpo)).toEqual([C.a])
    expect(ids((await pedir('adm', 'GET', '/v1/contatos/busca?q=D3%20Cliente')).corpo)).toEqual(TODOS_A)
  })

  it('fila do dia respeita o escopo', async () => {
    expect(ids((await pedir('va', 'GET', '/v1/fila-do-dia')).corpo)).toEqual([C.a])
    expect(ids((await pedir('adm', 'GET', '/v1/fila-do-dia')).corpo)).toEqual([C.a, C.b].sort())
  })

  it('sub-rotas de escrita e leitura do contato alheio → 404, sem efeito', async () => {
    const alvo = `/v1/contatos/${C.b}`
    expect((await pedir('va', 'PATCH', alvo, { nome: 'Invadido' })).status).toBe(404)
    expect((await pedir('va', 'POST', `${alvo}/telefones`, { telefone: '11987654321' })).status).toBe(404)
    expect((await pedir('va', 'POST', `${alvo}/telefones/1/principal`)).status).toBe(404)
    expect((await pedir('va', 'DELETE', `${alvo}/telefones/1`)).status).toBe(404)
    expect((await pedir('va', 'POST', `${alvo}/documentos`, { tipo: 'cpf', numero: '52998224725' })).status).toBe(404)
    expect((await pedir('va', 'DELETE', `${alvo}/documentos/1`)).status).toBe(404)
    expect((await pedir('va', 'PUT', `${alvo}/endereco`, { cidade: 'X' })).status).toBe(404)
    expect((await pedir('va', 'GET', `${alvo}/comentarios`)).status).toBe(404)
    expect((await pedir('va', 'POST', `${alvo}/comentarios`, { texto: 'oi' })).status).toBe(404)
    expect((await pedir('va', 'GET', `${alvo}/segmento/historico`)).status).toBe(404)
    expect((await pedir('va', 'GET', `${alvo}/carteira/historico`)).status).toBe(404)
    expect((await pedir('va', 'POST', `${alvo}/carteira`, { usuarioId: U.va })).status).toBe(404)
    expect((await pedir('va', 'GET', `${alvo}/pedidos`)).status).toBe(404)
    expect((await pedir('va', 'GET', `${alvo}/etiquetas`)).status).toBe(404)
    expect((await pedir('va', 'PUT', `${alvo}/etiquetas`, { etiquetaIds: [] })).status).toBe(404)
    expect((await pedir('va', 'PUT', alvo, { nome: 'Invadido', telefone: '11987654321' })).status).toBe(404)
    const [c] = await dono<{ nome: string }[]>`SELECT nome FROM contato WHERE tenant_id = ${A} AND id = ${C.b}`
    expect(c!.nome).toBe('D3 Cliente Beta')
    const [n] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM contato_telefone WHERE tenant_id = ${A} AND contato_id = ${C.b}`
    expect(n!.n).toBe(0)
    const [dono_] = await dono<{ usuario_id: string }[]>`SELECT usuario_id FROM carteira_atribuicao WHERE tenant_id = ${A} AND contato_id = ${C.b} AND ate IS NULL`
    expect(dono_!.usuario_id).toBe(U.vb)
    // Na própria carteira, a mesma rota funciona.
    expect((await pedir('va', 'POST', `/v1/contatos/${C.a}/comentarios`, { texto: 'meu cliente' })).status).toBe(201)
  })

  it('papel muda → vale na PRÓXIMA requisição (sem cache)', async () => {
    await dono`UPDATE usuario_filial SET papel = 'admin' WHERE tenant_id = ${A} AND usuario_id = ${U.va}`
    expect(ids((await pedir('va', 'GET', '/v1/contatos')).corpo)).toEqual(TODOS_A)
    await dono`UPDATE usuario_filial SET papel = 'vendedor' WHERE tenant_id = ${A} AND usuario_id = ${U.va}`
    expect(ids((await pedir('va', 'GET', '/v1/contatos')).corpo)).toEqual([C.a])
  })
})

describe('dois tenants', () => {
  it('admin de A não alcança contato de B (RLS) — 404', async () => {
    expect((await pedir('adm', 'GET', `/v1/contatos/${C.t2}`)).status).toBe(404)
    expect(ids((await pedir('adm', 'GET', '/v1/contatos')).corpo)).not.toContain(C.t2)
  })

  it('tenant B sem admin = modo fundador: quem existe vê tudo do PRÓPRIO tenant, inclusive a carteira do colega', async () => {
    expect(ids((await pedir('bx', 'GET', '/v1/contatos')).corpo)).toEqual([C.t2, C.t2b].sort())
    expect((await pedir('bx', 'GET', `/v1/contatos/${C.t2}`)).status).toBe(200)
    expect((await pedir('bx', 'GET', `/v1/contatos/${C.a}`)).status).toBe(404)
  })
})

describe('carteiras', () => {
  it('vendedora pedindo a carteira do colega ou os órfãos recebe vazio; a própria, cheia', async () => {
    expect(ids((await pedir('va', 'GET', `/v1/carteiras/contatos?usuarioId=${U.vb}`)).corpo)).toEqual([])
    expect(ids((await pedir('va', 'GET', '/v1/carteiras/contatos?orfaos=1')).corpo)).toEqual([])
    expect(ids((await pedir('va', 'GET', `/v1/carteiras/contatos?usuarioId=${U.va}`)).corpo)).toEqual([C.a])
  })

  it('gestor de X vê os órfãos sem filial (para distribuir), não o órfão de Y; admin vê os dois', async () => {
    expect(ids((await pedir('gx', 'GET', '/v1/carteiras/contatos?orfaos=1')).corpo)).toEqual([C.o])
    expect(ids((await pedir('gx', 'GET', `/v1/carteiras/contatos?usuarioId=${U.vb}`)).corpo)).toEqual([])
    expect(ids((await pedir('adm', 'GET', '/v1/carteiras/contatos?orfaos=1')).corpo)).toEqual([C.o, C.oy].sort())
  })
})

describe('tarefas', () => {
  it('vendedora vê as suas e as de ninguém (avulsa ou de cliente dela); não as do colega', async () => {
    expect(ids((await pedir('va', 'GET', '/v1/tarefas')).corpo)).toEqual([T.a, T.livre].sort())
    expect(ids((await pedir('vb', 'GET', '/v1/tarefas')).corpo)).toEqual([T.b, T.livre, T.livreB].sort())
  })

  it('gestor de X vê as dos vendedores de X; admin vê todas', async () => {
    expect(ids((await pedir('gx', 'GET', '/v1/tarefas')).corpo)).toEqual([T.a, T.livre].sort())
    expect(ids((await pedir('adm', 'GET', '/v1/tarefas')).corpo)).toEqual([T.a, T.b, T.livre, T.livreB].sort())
  })

  it('concluir/cancelar tarefa alheia → 404 e nada muda; criar tarefa sobre cliente alheio → 404', async () => {
    expect((await pedir('va', 'POST', `/v1/tarefas/${T.b}/concluir`)).status).toBe(404)
    expect((await pedir('va', 'POST', `/v1/tarefas/${T.b}/cancelar`)).status).toBe(404)
    const [t] = await dono<{ estado: string }[]>`SELECT estado FROM tarefa WHERE tenant_id = ${A} AND id = ${T.b}`
    expect(t!.estado).toBe('aberta')
    const venceEm = new Date(Date.now() + 86400000).toISOString()
    expect((await pedir('va', 'POST', '/v1/tarefas', { titulo: 'x', venceEm, contatoId: C.b })).status).toBe(404)
  })
})

describe('tarefas — contadores, sem próximo passo e lote', () => {
  it('contadores contam só o escopo', async () => {
    expect((await pedir('va', 'GET', '/v1/tarefas/contadores')).corpo['pendentes']).toBe(2)
    expect((await pedir('adm', 'GET', '/v1/tarefas/contadores')).corpo['pendentes']).toBe(4)
  })

  it('sem-próximo-passo omite o contato fora do escopo', async () => {
    const r = await pedir('va', 'GET', `/v1/tarefas/sem-proximo-passo?contatoIds=${C.a},${C.b}`)
    expect(ids(r.corpo, 'contatoId')).toEqual([C.a])
  })

  it('lote: contato fora do escopo é ignorado e contado', async () => {
    const venceEm = new Date(Date.now() + 86400000).toISOString()
    const r = await pedir('va', 'POST', '/v1/tarefas/lote', { contatoIds: [C.a, C.b], titulo: 'Lote D3', venceEm })
    expect(r.status).toBe(201)
    expect(r.corpo).toMatchObject({ criadas: 1, ignorados: 1 })
    const [n] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM tarefa WHERE tenant_id = ${A} AND titulo = 'Lote D3' AND contato_id = ${C.b}`
    expect(n!.n).toBe(0)
    await dono`DELETE FROM tarefa WHERE tenant_id = ${A} AND titulo = 'Lote D3'`
  })
})

describe('pedidos', () => {
  it('vendedora vê o pedido do próprio cliente; o do colega some da lista e é 404 no detalhe e nas ações', async () => {
    expect(ids((await pedir('va', 'GET', '/v1/pedidos')).corpo)).toEqual([P.a])
    expect((await pedir('va', 'GET', `/v1/pedidos/${P.a}`)).status).toBe(200)
    expect((await pedir('va', 'GET', `/v1/pedidos/${P.b}`)).status).toBe(404)
    expect((await pedir('va', 'POST', `/v1/pedidos/${P.b}/cancelar`, { motivo: 'x' })).status).toBe(404)
    expect((await pedir('va', 'PATCH', `/v1/pedidos/${P.b}`, { observacao: 'x' })).status).toBe(404)
    expect((await pedir('va', 'POST', '/v1/pedidos', { contatoId: C.b })).status).toBe(404)
    const [p] = await dono<{ estado: string }[]>`SELECT estado FROM pedido WHERE tenant_id = ${A} AND id = ${P.b}`
    expect(p!.estado).toBe('rascunho')
  })

  it('gestor de X vê os de X; admin vê todos', async () => {
    expect(ids((await pedir('gx', 'GET', '/v1/pedidos')).corpo)).toEqual([P.a])
    expect((await pedir('gx', 'GET', `/v1/pedidos/${P.b}`)).status).toBe(404)
    expect(ids((await pedir('adm', 'GET', '/v1/pedidos')).corpo)).toEqual([P.a, P.b].sort())
  })

  it('pedido de balcão (sem cliente) criado pela vendedora continua visível para ela — e só para ela e a gestão', async () => {
    const r = await pedir('va', 'POST', '/v1/pedidos', { novo: true })
    expect(r.status).toBe(201)
    const id = r.corpo.id as string
    expect((await pedir('va', 'GET', `/v1/pedidos/${id}`)).status).toBe(200)
    expect((await pedir('vb', 'GET', `/v1/pedidos/${id}`)).status).toBe(404)
    expect((await pedir('gx', 'GET', `/v1/pedidos/${id}`)).status).toBe(200)
    await dono`DELETE FROM pedido WHERE tenant_id = ${A} AND id = ${id}`
  })
})

describe('funil e leads', () => {
  it('coluna do funil e total do estágio contam só o escopo', async () => {
    expect(ids((await pedir('va', 'GET', `/v1/funil/coluna/${etapaFunil}`)).corpo)).toEqual([O.a])
    expect(ids((await pedir('gx', 'GET', `/v1/funil/coluna/${etapaFunil}`)).corpo)).toEqual([O.a])
    expect(ids((await pedir('adm', 'GET', `/v1/funil/coluna/${etapaFunil}`)).corpo)).toEqual([O.a, O.b].sort())
    const total = async (quem: 'va' | 'adm') =>
      ((await pedir(quem, 'GET', '/v1/funil/etapas')).corpo.itens ?? []).find((e) => e['id'] === etapaFunil)?.['total']
    expect(await total('va')).toBe(1)
    expect(await total('adm')).toBe(2)
  })

  it('mover card alheio → 404', async () => {
    expect((await pedir('va', 'POST', `/v1/funil/oportunidades/${O.b}/mover`, { etapaId: etapaFunil, versao: 0 })).status).toBe(404)
  })

  it('coluna de leads, contagem e qualificar respeitam o escopo', async () => {
    expect(ids((await pedir('va', 'GET', '/v1/leads/coluna/novo')).corpo, 'contatoId')).toEqual([C.a])
    expect(ids((await pedir('adm', 'GET', '/v1/leads/coluna/novo')).corpo, 'contatoId')).toEqual(TODOS_A)
    const colunas = (await pedir('va', 'GET', '/v1/leads/colunas')).corpo['colunas'] as { chave: string; total: number }[]
    expect(colunas.find((c) => c.chave === 'novo')?.total).toBe(1)
    expect((await pedir('va', 'POST', `/v1/leads/${C.b}/qualificar`, { estado: 'descartado' })).status).toBe(404)
    const [c] = await dono<{ qualificado: boolean | null }[]>`SELECT qualificado FROM contato WHERE tenant_id = ${A} AND id = ${C.b}`
    expect(c!.qualificado).toBeNull()
  })
})

describe('conversas — e a fila continua funcionando', () => {
  it('vendedora vê a conversa do próprio cliente e a FILA do número que ela atende; não a do colega', async () => {
    // CANAL1 sem ninguém vinculado → todos atendem; CANAL2 é só do VB.
    expect(ids((await pedir('va', 'GET', '/v1/conversas')).corpo)).toEqual([CV.a, CV.fila].sort())
    expect(ids((await pedir('vb', 'GET', '/v1/conversas')).corpo)).toEqual([CV.b, CV.fila, CV.fila2].sort())
    expect(ids((await pedir('va', 'GET', '/v1/conversas?filtro=fila')).corpo)).toEqual([CV.fila])
    expect((await pedir('va', 'GET', `/v1/conversas/${CV.b}`)).status).toBe(404)
    expect((await pedir('va', 'GET', `/v1/conversas/${CV.b}/mensagens?anteriorEm=2030-01-01T00:00:00Z&anteriorId=${CV.b}`)).status).toBe(404)
    expect((await pedir('va', 'POST', `/v1/conversas/${CV.b}/lida`)).status).toBe(404)
    expect((await pedir('va', 'GET', `/v1/conversas/${CV.fila2}`)).status).toBe(404)
    const cont = (await pedir('va', 'GET', '/v1/fila/contadores')).corpo
    expect(cont['fila']).toBe(1)
  })

  it('kanban de atendimento (coluna Aguardando) e envio de mensagem respeitam o escopo', async () => {
    expect(ids((await pedir('va', 'GET', '/v1/atendimento-kanban/aguardando')).corpo, 'conversaId')).toEqual([CV.fila])
    expect(ids((await pedir('vb', 'GET', '/v1/atendimento-kanban/aguardando')).corpo, 'conversaId')).toEqual([CV.fila, CV.fila2].sort())
    expect((await pedir('va', 'GET', '/v1/atendimento-kanban/etapas')).corpo['aguardando']).toEqual({ total: 1 })
    const envio = await pedir('va', 'POST', `/v1/conversas/${CV.b}/mensagens`, { texto: 'oi' })
    expect(envio.status).toBe(404)
    expect(envio.corpo.erro).toBe('conversa.nao_encontrada')
    const [n] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM mensagem WHERE tenant_id = ${A} AND conversa_id = ${CV.b}`
    expect(n!.n).toBe(0)
  })

  it('gestor de X: conversa do cliente de X e a fila do número sem vínculo; admin vê todas', async () => {
    expect(ids((await pedir('gx', 'GET', '/v1/conversas')).corpo)).toEqual([CV.a, CV.fila].sort())
    expect(ids((await pedir('adm', 'GET', '/v1/conversas')).corpo)).toEqual([CV.a, CV.b, CV.fila, CV.fila2].sort())
  })

  it('assumir da fila: a vendedora assume, passa a ver a conversa, a ficha e monta o pedido; o colega deixa de ver', async () => {
    const r = await pedir('va', 'POST', `/v1/conversas/${CV.fila}/assumir`)
    expect(r.status).toBe(201)
    expect((await pedir('va', 'GET', `/v1/conversas/${CV.fila}`)).status).toBe(200)
    expect(ids((await pedir('va', 'GET', '/v1/conversas?filtro=meus')).corpo)).toEqual([CV.fila])
    // Em atendimento com ela: a ficha do órfão abre, e o pedido nasce na conversa.
    expect((await pedir('va', 'GET', `/v1/contatos/${C.o}`)).status).toBe(200)
    const ped = await pedir('va', 'POST', '/v1/pedidos', { conversaId: CV.fila })
    expect(ped.status).toBe(201)
    expect((await pedir('va', 'GET', `/v1/pedidos/${ped.corpo.id as string}`)).status).toBe(200)
    // Saiu da fila → o colega (sem relação com o cliente) não vê mais.
    expect((await pedir('vb', 'GET', `/v1/conversas/${CV.fila}`)).status).toBe(404)
    expect(ids((await pedir('vb', 'GET', '/v1/conversas?filtro=fila')).corpo)).toEqual([CV.fila2])
    expect((await pedir('vb', 'GET', `/v1/pedidos/${ped.corpo.id as string}`)).status).toBe(404)
  })

  it('devolver ao agente e reatribuir: só sobre conversa visível; o destino precisa poder atender', async () => {
    expect((await pedir('va', 'POST', `/v1/conversas/${CV.b}/devolver-agente`, { motivo: 'outro' })).status).toBe(404)
    // Gestor de X não enxerga a conversa do cliente de Y → 404.
    expect((await pedir('gx', 'POST', `/v1/conversas/${CV.b}/reatribuir`, { usuarioId: U.va, motivo: 'teste' })).status).toBe(404)
    // CV.fila2 é do CANAL2 (só VB atende) e o cliente é órfão de Y.
    expect((await pedir('vb', 'POST', `/v1/conversas/${CV.fila2}/assumir`)).status).toBe(201)
    const semAcesso = await pedir('adm', 'POST', `/v1/conversas/${CV.fila2}/reatribuir`, { usuarioId: U.va, motivo: 'teste' })
    expect(semAcesso.status).toBe(422)
    expect(semAcesso.corpo.erro).toBe('reatribuicao.destino_sem_acesso')
    const [at] = await dono<{ atendente_id: string }[]>`SELECT atendente_id FROM atendimento WHERE tenant_id = ${A} AND conversa_id = ${CV.fila2} AND estado <> 'encerrado'`
    expect(at!.atendente_id).toBe(U.vb)
    // Supervisor de todas as filiais pode atender → reatribuição passa.
    expect((await pedir('adm', 'POST', `/v1/conversas/${CV.fila2}/reatribuir`, { usuarioId: U.sup, motivo: 'teste' })).status).toBe(200)
  })

  it('protocolo de conversa fora do escopo → não encontrado', async () => {
    const [a] = await dono<{ protocolo: string }[]>`SELECT protocolo::text FROM atendimento WHERE tenant_id = ${A} AND conversa_id = ${CV.fila}`
    expect((await pedir('va', 'GET', `/v1/conversas/por-protocolo?p=${a!.protocolo}`)).status).toBe(200)
    expect((await pedir('vb', 'GET', `/v1/conversas/por-protocolo?p=${a!.protocolo}`)).status).toBe(404)
  })
})
