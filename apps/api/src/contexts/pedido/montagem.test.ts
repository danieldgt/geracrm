import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import type { FastifyInstance } from 'fastify'
import { criarApp } from '../../app.js'
import { comTenantServico, encerrarBanco } from '../../db/index.js'
import {
  adicionarItemPorSku, alterarQuantidade, lerRascunho, obterOuCriarRascunho, perfilDoContato,
  regrasPedidoDoTenant, removerItem, voltarARascunho,
} from './montagem.js'

/**
 * MONTAGEM POR SKU — o preço resolvido no servidor (ADR-025).
 *
 * ⚠️ Roda sob `comTenantServico` (papel `geracrm_api`, sem BYPASSRLS): é a RLS
 * quem faz o SKU do tenant B voltar como `sku_desconhecido` para o tenant A.
 * Testar isso com a conexão de dono passa sempre e não prova nada.
 */
const A = 'f4a10000-0000-4000-8000-000000000001'
const B = 'f4a10000-0000-4000-8000-000000000002'
const PVA = 'f4a10000-1111-4000-8000-000000000001'
const PVB = 'f4a10000-1111-4000-8000-000000000002'
const PLANO = 'f4a10000-3333-4000-8000-000000000001'
const MODELO = 'f4a10000-4444-4000-8000-000000000001'
const CONTATO_A = 'f4a10000-6666-4000-8000-000000000001'   // sem perfil declarado → atacado
const CONTATO_VAREJO = 'f4a10000-6666-4000-8000-000000000002'
const CONTATO_B = 'f4a10000-6666-4000-8000-000000000003'
const CANAL = 'f4a10000-7777-4000-8000-000000000001'
const CONV = 'f4a10000-8888-4000-8000-000000000001'
const PROD_A = 'f4a10000-5555-4000-8000-00000000000a'
const PROD_B = 'f4a10000-5555-4000-8000-00000000000b'
const SKU_A = 'f4a10000-aaaa-4000-8000-00000000000a'   // com preço nos dois perfis
const SKU_SEM_PRECO = 'f4a10000-aaaa-4000-8000-00000000000c'
const SKU_B = 'f4a10000-aaaa-4000-8000-00000000000b'   // do tenant B
const SISTEMA = 'erp:teste-montagem-sku'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const chamar = (t: string, m: 'GET' | 'POST' | 'PATCH', url: string, corpo?: Record<string, unknown>) =>
  app.inject({ method: m, url, headers: { 'x-tenant-id': t }, ...(corpo ? { payload: corpo } : {}) })
const comoA = <X>(fn: Parameters<typeof comTenantServico<X>>[1]) => comTenantServico(A, fn)
const comoB = <X>(fn: Parameters<typeof comTenantServico<X>>[1]) => comTenantServico(B, fn)

const tabela = (tenant: string, sku: string, idExterno: string, perfil: 'varejo' | 'atacado', centavos: number) =>
  dono.begin(async (tx) => {
    await tx`INSERT INTO tabela_preco (tenant_id, id_externo, descricao, padrao, sistema, proposito, ativa, perfil)
             VALUES (${tenant}, ${idExterno}, ${'Tabela ' + perfil}, false, ${SISTEMA}, 'venda', true, ${perfil})
             ON CONFLICT (tenant_id, sistema, id_externo) DO NOTHING`
    await tx`INSERT INTO sku_preco (tenant_id, sku_id, tabela_externa, preco_centavos)
             VALUES (${tenant}, ${sku}, ${idExterno}, ${centavos})
             ON CONFLICT (tenant_id, sku_id, tabela_externa) DO UPDATE SET preco_centavos = EXCLUDED.preco_centavos`
  })

async function rascunho(tenant = A, contatoId: string | null = CONTATO_A): Promise<string> {
  const id = randomUUID()
  await dono`INSERT INTO pedido (tenant_id, id, contato_id, estado) VALUES (${tenant}, ${id}, ${contatoId}, 'rascunho')`
  return id
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-montagem-sku', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-montagem-sku', 'Moda') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[A, PVA, 'Loja A'], [B, PVB, 'Loja B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Moda') ON CONFLICT DO NOTHING`
    })
  }
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo, perfil_preco)
             VALUES (${A}, ${CONTATO_A}, 'Atacadista', 'teste', true, NULL),
                    (${A}, ${CONTATO_VAREJO}, 'Varejista', 'teste', true, 'varejo'),
                    (${B}, ${CONTATO_B}, 'Cliente B', 'teste', true, NULL) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES (${A}, ${CANAL}, 'whatsapp_oficial', 'Zap', 'conectado') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id) VALUES (${A}, ${CONV}, ${CANAL}, ${CONTATO_A}) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO produto (tenant_id, id, referencia, descricao) VALUES (${A}, ${PROD_A}, 'REF-A', 'Camisa Polo'), (${B}, ${PROD_B}, 'REF-B', 'Calça') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO sku (tenant_id, id, produto_id, atributos, codigo_barras)
             VALUES (${A}, ${SKU_A}, ${PROD_A}, '{"cor":"Azul","tamanho":"M"}'::jsonb, '789000000001'),
                    (${A}, ${SKU_SEM_PRECO}, ${PROD_A}, '{"cor":"Azul","tamanho":"G"}'::jsonb, NULL),
                    (${B}, ${SKU_B}, ${PROD_B}, '{"cor":"Preto"}'::jsonb, '789000000002') ON CONFLICT DO NOTHING`
  await tabela(A, SKU_A, 'ATAC', 'atacado', 5_000)
  await tabela(A, SKU_A, 'VAR', 'varejo', 8_900)
  await tabela(B, SKU_B, 'ATAC', 'atacado', 1_000)
  app = await criarApp(); await app.ready()
})

beforeEach(async () => {
  await dono`DELETE FROM pedido WHERE tenant_id IN (${A}, ${B})`
  await dono`DELETE FROM sku_saldo WHERE tenant_id IN (${A}, ${B})`
  await dono`UPDATE perfil_vertical SET regras_pedido = '{}'::jsonb WHERE tenant_id = ${A}`
})

afterAll(async () => {
  for (const t of [A, B]) {
    await dono`DELETE FROM pedido WHERE tenant_id = ${t}`
    await dono`DELETE FROM sku_saldo WHERE tenant_id = ${t}`
    await dono`DELETE FROM sku_preco WHERE tenant_id = ${t}`
    await dono`DELETE FROM tabela_preco WHERE tenant_id = ${t}`
    await dono`DELETE FROM sku WHERE tenant_id = ${t}`
    await dono`DELETE FROM produto WHERE tenant_id = ${t}`
    await dono`DELETE FROM conversa WHERE tenant_id = ${t}`
    await dono`DELETE FROM canal_conectado WHERE tenant_id = ${t}`
    await dono`DELETE FROM contato WHERE tenant_id = ${t}`
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('perfilDoContato', () => {
  it('contato sem perfil declarado cota pelo padrão (atacado); declarado vale', async () => {
    expect(await comoA((tx) => perfilDoContato(tx, CONTATO_A))).toBe('atacado')
    expect(await comoA((tx) => perfilDoContato(tx, CONTATO_VAREJO))).toBe('varejo')
    expect(await comoA((tx) => perfilDoContato(tx, null))).toBe('atacado')
  })
})

describe('adicionarItemPorSku — preço resolvido no servidor (ADR-025)', () => {
  it('dado contato sem perfil, quando adiciona o SKU, então cota ATACADO e grava o snapshot', async () => {
    const id = await rascunho()
    const r = await comoA((tx) => adicionarItemPorSku(tx, id, { skuId: SKU_A, quantidade: 2 }))
    expect(r).toEqual({ tipo: 'ok', seq: 1, quantidade: 2, valorUnitarioCentavos: 5_000, totalCentavos: 10_000 })
    const lido = await comoA((tx) => lerRascunho(tx, id))
    expect(lido!.itens[0]).toMatchObject({
      skuId: SKU_A, skuSnapshot: '789000000001', descricaoSnapshot: 'Camisa Polo',
      grade: { cor: 'Azul', tamanho: 'M' }, quantidade: 2, valorUnitarioCentavos: 5_000,
    })
    expect(lido!.pedido).toMatchObject({ totalCentavos: 10_000, totalPecas: 2, versaoConteudo: 1, origem: 'humano' })
  })

  it('dado contato VAREJO, então cota pela tabela de varejo', async () => {
    const id = await rascunho(A, CONTATO_VAREJO)
    const r = await comoA((tx) => adicionarItemPorSku(tx, id, { skuId: SKU_A, quantidade: 1 }))
    expect(r).toMatchObject({ tipo: 'ok', valorUnitarioCentavos: 8_900 })
  })

  it('o mesmo SKU de novo SOMA na linha existente e mantém o preço combinado (INV-25)', async () => {
    const id = await rascunho()
    await comoA((tx) => adicionarItemPorSku(tx, id, { skuId: SKU_A, quantidade: 2 }))
    await tabela(A, SKU_A, 'ATAC', 'atacado', 6_000) // o preço subiu no ERP
    const r = await comoA((tx) => adicionarItemPorSku(tx, id, { skuId: SKU_A, quantidade: 3 }))
    expect(r).toEqual({ tipo: 'ok', seq: 1, quantidade: 5, valorUnitarioCentavos: 5_000, totalCentavos: 25_000 })
    expect((await comoA((tx) => lerRascunho(tx, id)))!.itens.length).toBe(1)
    await tabela(A, SKU_A, 'ATAC', 'atacado', 5_000)
  })

  it('SKU sem preço na tabela do perfil → sem_preco (nada gravado)', async () => {
    const id = await rascunho()
    expect(await comoA((tx) => adicionarItemPorSku(tx, id, { skuId: SKU_SEM_PRECO, quantidade: 1 }))).toEqual({ tipo: 'sem_preco' })
    expect((await comoA((tx) => lerRascunho(tx, id)))!.itens).toEqual([])
  })

  it('SKU inexistente → sku_desconhecido', async () => {
    const id = await rascunho()
    expect(await comoA((tx) => adicionarItemPorSku(tx, id, { skuId: randomUUID(), quantidade: 1 }))).toEqual({ tipo: 'sku_desconhecido' })
  })

  it('⚠️ isolamento: SKU do tenant B é desconhecido para o tenant A (RLS, papel da aplicação)', async () => {
    const id = await rascunho()
    expect(await comoA((tx) => adicionarItemPorSku(tx, id, { skuId: SKU_B, quantidade: 1 }))).toEqual({ tipo: 'sku_desconhecido' })
    // E o tenant B cota o próprio SKU normalmente.
    const idB = await rascunho(B, CONTATO_B)
    expect(await comoB((tx) => adicionarItemPorSku(tx, idB, { skuId: SKU_B, quantidade: 1 }))).toMatchObject({ tipo: 'ok', valorUnitarioCentavos: 1_000 })
    // ⚠️ E o pedido do tenant A não existe para o B.
    expect(await comoB((tx) => adicionarItemPorSku(tx, id, { skuId: SKU_B, quantidade: 1 }))).toEqual({ tipo: 'pedido_nao_encontrado' })
  })

  it('pedido que não é rascunho é imutável', async () => {
    const id = await rascunho()
    await dono`UPDATE pedido SET estado = 'efetivado' WHERE id = ${id}`
    expect(await comoA((tx) => adicionarItemPorSku(tx, id, { skuId: SKU_A, quantidade: 1 }))).toEqual({ tipo: 'pedido_imutavel', estado: 'efetivado' })
  })

  it('quantidade inválida nomeia a regra', async () => {
    const id = await rascunho()
    expect(await comoA((tx) => adicionarItemPorSku(tx, id, { skuId: SKU_A, quantidade: 0 }))).toEqual({ tipo: 'quantidade_invalida', regra: 'maior_que_zero' })
    expect(await comoA((tx) => adicionarItemPorSku(tx, id, { skuId: SKU_A, quantidade: 100_001 }))).toEqual({ tipo: 'quantidade_invalida', regra: 'acima_do_teto' })
  })

  it('`perfil` explícito (transitório, console) cota por cima do perfil do contato', async () => {
    const id = await rascunho()
    const r = await comoA((tx) => adicionarItemPorSku(tx, id, { skuId: SKU_A, quantidade: 1 }, { perfil: 'varejo' }))
    expect(r).toMatchObject({ tipo: 'ok', valorUnitarioCentavos: 8_900 })
  })
})

describe('Estoque na montagem (sku_saldo da última sincronização)', () => {
  it('dado saldo 3, quando pede 5, então estoque_insuficiente com o disponível', async () => {
    await dono`INSERT INTO sku_saldo (tenant_id, sku_id, quantidade) VALUES (${A}, ${SKU_A}, 3)`
    const id = await rascunho()
    const r = await comoA((tx) => adicionarItemPorSku(tx, id, { skuId: SKU_A, quantidade: 5 }))
    expect(r).toEqual({ tipo: 'estoque_insuficiente', disponivel: 3, skuSnapshot: '789000000001' })
    // Dentro do saldo passa; somar acima do saldo recusa de novo.
    expect((await comoA((tx) => adicionarItemPorSku(tx, id, { skuId: SKU_A, quantidade: 2 }))).tipo).toBe('ok')
    expect((await comoA((tx) => adicionarItemPorSku(tx, id, { skuId: SKU_A, quantidade: 2 }))).tipo).toBe('estoque_insuficiente')
    expect((await comoA((tx) => alterarQuantidade(tx, id, 1, 4))).tipo).toBe('estoque_insuficiente')
    expect((await comoA((tx) => alterarQuantidade(tx, id, 1, 3))).tipo).toBe('ok')
  })

  it('⚠️ sem linha de saldo o tenant não controla aqui: passa (ADR-008, valida na efetivação)', async () => {
    const id = await rascunho()
    expect((await comoA((tx) => adicionarItemPorSku(tx, id, { skuId: SKU_A, quantidade: 9_999 }))).tipo).toBe('ok')
  })
})

describe('alterarQuantidade / removerItem / lerRascunho', () => {
  it('altera, remove e recalcula; item inexistente é nomeado', async () => {
    const id = await rascunho()
    await comoA((tx) => adicionarItemPorSku(tx, id, { skuId: SKU_A, quantidade: 2 }))
    expect(await comoA((tx) => alterarQuantidade(tx, id, 1, 5))).toEqual({ tipo: 'ok', totalCentavos: 25_000 })
    expect(await comoA((tx) => alterarQuantidade(tx, id, 9, 5))).toEqual({ tipo: 'item_nao_encontrado' })
    expect(await comoA((tx) => alterarQuantidade(tx, id, 1, -1))).toEqual({ tipo: 'quantidade_invalida', regra: 'maior_que_zero' })
    expect(await comoA((tx) => removerItem(tx, id, 1))).toEqual({ tipo: 'ok', totalCentavos: 0 })
    expect(await comoA((tx) => removerItem(tx, id, 1))).toEqual({ tipo: 'item_nao_encontrado' })
    const lido = await comoA((tx) => lerRascunho(tx, id))
    expect(lido!.pedido.versaoConteudo).toBe(3) // três mutações, três versões
    expect(await comoB((tx) => lerRascunho(tx, id))).toBeNull()
  })
})

describe('obterOuCriarRascunho', () => {
  it('reaproveita o rascunho da conversa; `novo` cria outro; herda o contato da conversa', async () => {
    const a = await comoA((tx) => obterOuCriarRascunho(tx, { conversaId: CONV }))
    expect(a.criado).toBe(true)
    const b = await comoA((tx) => obterOuCriarRascunho(tx, { conversaId: CONV }))
    expect(b).toEqual({ id: a.id, criado: false })
    const lido = await comoA((tx) => lerRascunho(tx, a.id))
    expect(lido!.pedido.contatoId).toBe(CONTATO_A)
    const c = await comoA((tx) => obterOuCriarRascunho(tx, { contatoId: CONTATO_A, novo: true }))
    expect(c.criado).toBe(true)
    expect(c.id).not.toBe(a.id)
  })

  it('origem agente fica gravada no pedido (ADR-027)', async () => {
    const r = await comoA((tx) => obterOuCriarRascunho(tx, { contatoId: CONTATO_A, origem: 'agente', novo: true }))
    const lido = await comoA((tx) => lerRascunho(tx, r.id))
    expect(lido!.pedido.origem).toBe('agente')
    expect(lido!.pedido.descontoPct).toBe(0)
  })

  it('⚠️ dois dispositivos ao mesmo tempo na mesma conversa produzem UM rascunho (INV-52)', async () => {
    const [x, y] = await Promise.all([
      comoA((tx) => obterOuCriarRascunho(tx, { conversaId: CONV })),
      comoA((tx) => obterOuCriarRascunho(tx, { conversaId: CONV })),
    ])
    expect(x.id).toBe(y.id)
    const [n] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM pedido WHERE tenant_id = ${A} AND conversa_id = ${CONV} AND estado = 'rascunho'`
    expect(n!.n).toBe(1)
  })
})

describe('voltarARascunho e regras do tenant', () => {
  it('aguardando_confirmacao volta a rascunho e invalida a proposta vigente', async () => {
    const id = await rascunho()
    await dono`UPDATE pedido SET estado = 'aguardando_confirmacao', resumo_enviado_em = now() WHERE id = ${id}`
    await dono`INSERT INTO pedido_proposta (tenant_id, id, pedido_id, versao_conteudo, resumo, total_centavos, enviada_em, expira_em)
               VALUES (${A}, ${randomUUID()}, ${id}, 0, 'x', 0, now(), now() + interval '24 hours')`
    expect(await comoA((tx) => voltarARascunho(tx, id))).toEqual({ tipo: 'ok' })
    const [p] = await dono<{ estado: string; resumo_enviado_em: Date | null }[]>`SELECT estado, resumo_enviado_em FROM pedido WHERE id = ${id}`
    expect(p).toEqual({ estado: 'rascunho', resumo_enviado_em: null })
    const [pr] = await dono<{ vigente: boolean }[]>`SELECT vigente FROM pedido_proposta WHERE pedido_id = ${id}`
    expect(pr!.vigente).toBe(false)
    await dono`UPDATE pedido SET estado = 'efetivado' WHERE id = ${id}`
    expect(await comoA((tx) => voltarARascunho(tx, id))).toEqual({ tipo: 'estado_invalido', estado: 'efetivado' })
  })

  it('regrasPedidoDoTenant lê o jsonb do perfil ativo', async () => {
    expect(await comoA((tx) => regrasPedidoDoTenant(tx))).toEqual({})
    await dono`UPDATE perfil_vertical SET regras_pedido = '{"minimo_pecas": 10}'::jsonb WHERE tenant_id = ${A}`
    expect(await comoA((tx) => regrasPedidoDoTenant(tx))).toEqual({ minimo_pecas: 10 })
    // ⚠️ A regra do tenant A não vaza para o B.
    expect(await comoB((tx) => regrasPedidoDoTenant(tx))).toEqual({})
  })
})

/**
 * O CONTRATO HTTP (ADR-025): com `skuId` o corpo não carrega preço; sem `skuId`
 * é item de texto livre com preço da tela (até a raia R7 trocar o console).
 */
describe('POST /v1/pedidos/:id/itens — preço resolvido no servidor', () => {
  it('com skuId, o preço do corpo é IGNORADO e o servidor cota pelo perfil do contato', async () => {
    const id = (await chamar(A, 'POST', '/v1/pedidos', { contatoId: CONTATO_A, novo: true }).then((r) => r.json())).id as string
    const r = await chamar(A, 'POST', `/v1/pedidos/${id}/itens`, { skuId: SKU_A, quantidade: 2, valorUnitarioCentavos: 1 })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ ok: true, seq: 1, valorUnitarioCentavos: 5_000, totalCentavos: 10_000 })
    const det = (await chamar(A, 'GET', `/v1/pedidos/${id}`)).json() as { origem: string; descontoPct: number; itens: { valorUnitarioCentavos: number; skuSnapshot: string }[] }
    expect(det.itens[0]).toMatchObject({ valorUnitarioCentavos: 5_000, skuSnapshot: '789000000001' })
    expect(det).toMatchObject({ origem: 'humano', descontoPct: 0 })
  })

  it('falhas nomeadas: sku desconhecido 422, sem preço 422, estoque 409', async () => {
    const id = (await chamar(A, 'POST', '/v1/pedidos', { contatoId: CONTATO_A, novo: true }).then((r) => r.json())).id as string
    const desconhecido = await chamar(A, 'POST', `/v1/pedidos/${id}/itens`, { skuId: SKU_B, quantidade: 1 })
    expect(desconhecido.statusCode).toBe(422)
    expect((desconhecido.json() as { erro: string }).erro).toBe('pedido.sku_desconhecido')
    const semPreco = await chamar(A, 'POST', `/v1/pedidos/${id}/itens`, { skuId: SKU_SEM_PRECO, quantidade: 1 })
    expect((semPreco.json() as { erro: string }).erro).toBe('pedido.sem_preco')
    await dono`INSERT INTO sku_saldo (tenant_id, sku_id, quantidade) VALUES (${A}, ${SKU_A}, 1)`
    const estoque = await chamar(A, 'POST', `/v1/pedidos/${id}/itens`, { skuId: SKU_A, quantidade: 2 })
    expect(estoque.statusCode).toBe(409)
    expect(estoque.json()).toMatchObject({ erro: 'pedido.estoque_insuficiente', disponivel: 1 })
    expect((await chamar(A, 'POST', `/v1/pedidos/${id}/itens`, { skuId: 'nao-e-uuid', quantidade: 1 })).statusCode).toBe(422)
  })

  it('sem skuId é texto livre: descrição + preço da tela, sku_id nulo (legado até a R7)', async () => {
    const id = (await chamar(A, 'POST', '/v1/pedidos', { contatoId: CONTATO_A, novo: true }).then((r) => r.json())).id as string
    const r = await chamar(A, 'POST', `/v1/pedidos/${id}/itens`, { descricaoSnapshot: 'Frete', quantidade: 1, valorUnitarioCentavos: 1_500 })
    expect(r.statusCode).toBe(200)
    const [item] = await dono<{ sku_id: string | null; valor_unitario_centavos: string }[]>`SELECT sku_id, valor_unitario_centavos::text FROM pedido_item WHERE pedido_id = ${id}`
    expect(item).toEqual({ sku_id: null, valor_unitario_centavos: '1500' })
  })

  it('lista expõe origem e descontoPct', async () => {
    await comoA((tx) => obterOuCriarRascunho(tx, { contatoId: CONTATO_A, origem: 'agente', novo: true }))
    const lista = (await chamar(A, 'GET', '/v1/pedidos')).json() as { itens: { origem: string; descontoPct: number }[] }
    expect(lista.itens[0]).toMatchObject({ origem: 'agente', descontoPct: 0 })
  })
})

describe('PATCH /v1/contatos/:id — perfilPreco (ADR-025)', () => {
  it('declara, lê de volta na ficha e volta ao padrão com null; valor inválido é 422', async () => {
    expect((await chamar(A, 'PATCH', `/v1/contatos/${CONTATO_A}`, { perfilPreco: 'varejo' })).statusCode).toBe(200)
    expect((await chamar(A, 'GET', `/v1/contatos/${CONTATO_A}`)).json()).toMatchObject({ perfilPreco: 'varejo' })
    expect(await comoA((tx) => perfilDoContato(tx, CONTATO_A))).toBe('varejo')
    expect((await chamar(A, 'PATCH', `/v1/contatos/${CONTATO_A}`, { perfilPreco: 'custo' })).statusCode).toBe(422)
    expect((await chamar(A, 'PATCH', `/v1/contatos/${CONTATO_A}`, { perfilPreco: null })).statusCode).toBe(200)
    expect((await chamar(A, 'GET', `/v1/contatos/${CONTATO_A}`)).json()).toMatchObject({ perfilPreco: null })
    // ⚠️ Outro tenant não altera o contato.
    expect((await chamar(B, 'PATCH', `/v1/contatos/${CONTATO_A}`, { perfilPreco: 'varejo' })).statusCode).toBe(404)
  })
})
