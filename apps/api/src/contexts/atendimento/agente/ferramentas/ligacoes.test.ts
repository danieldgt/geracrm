import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { encerrarBanco, comTenantServico } from '../../../../db/index.js'
import { criarProdutoManual } from '../../../catalogo/escrita-manual.js'
import { reindexarTenant } from '../../../catalogo/indexador.js'
import { confirmarPedidoPorResposta } from '../../../pedido/confirmacao-pedido.js'
import { pedidoReal, pedidoEnsaio, ligacoesPadrao } from './ligacoes.js'
import type { ContextoFerramenta } from './porta.js'

/**
 * As LIGAÇÕES reais com pedido e catálogo — os dois achados graves da revisão:
 *  (A2) mexer no pedido depois da proposta invalida a proposta;
 *  (A3) sombra/assistido/simulação nunca tocam o pedido real.
 */
const T = 'b5f50000-0000-4000-8000-000000000001'
const PV = 'b5f50000-1111-4000-8000-000000000001'
const PLANO = 'b5f50000-3333-4000-8000-000000000001'
const MODELO = 'b5f50000-4444-4000-8000-000000000001'
const CANAL = 'b5f50000-5555-4000-8000-000000000001'
const CONTATO = 'b5f50000-6666-4000-8000-000000000001'
const CONVERSA = 'b5f50000-7777-4000-8000-000000000001'
const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let skuId = ''

const ctx = (modo: ContextoFerramenta['modo']): ContextoFerramenta => ({
  tenantId: T, conversaId: CONVERSA, contatoId: CONTATO, canalId: CANAL, perfil: 'atacado', sessaoId: null, modo, agora: new Date(),
  enviar: (async (_t: string, _c: string, texto: string) => ({ ok: true, conversaId: CONVERSA, mensagemId: crypto.randomUUID(), texto })) as never,
})

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-ligacoes-agente', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-ligacoes-agente', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'Ligações', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES (${T}, ${CANAL}, 'whatsapp_nao_oficial', 'Loja', 'conectado') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato (tenant_id, id, nome, ativo) VALUES (${T}, ${CONTATO}, 'Cliente', true) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
             VALUES (${T}, ${CONTATO}, 1, '5585999991111', '5585999991111', true, true, 'teste') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao, ultima_entrante_em) VALUES (${T}, ${CONVERSA}, ${CANAL}, ${CONTATO}, 1, now()) ON CONFLICT DO NOTHING`
  await comTenantServico(T, async (tx) => {
    const r = await criarProdutoManual(tx, { referencia: 'LIG-001', descricao: 'Camiseta ligação', skus: [{ atributos: { cor: 'verde', tamanho: 'G' }, precos: { varejo: 5990, atacado: 3990 }, saldo: 10 }] })
    if (!r.ok) throw new Error(r.falha.erro)
    skuId = r.valor.skus[0]!
    await reindexarTenant(tx, { tenantId: T, lote: 10 })
  })
})
beforeEach(async () => {
  await dono`DELETE FROM pedido WHERE tenant_id = ${T}`
  await dono`DELETE FROM mensagem WHERE tenant_id = ${T}`
})
afterAll(async () => {
  for (const t of ['pedido_proposta', 'pedido_item', 'pedido', 'mensagem', 'conversa', 'contato_telefone', 'contato', 'produto_indice', 'sku_preco', 'sku_saldo', 'sku', 'produto', 'tabela_preco', 'canal_conectado', 'outbox']) {
    await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id = '${T}'`)
  }
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await encerrarBanco(); await dono.end()
})

describe('Pedido real (autônomo)', () => {
  it('⚠️ mudar o pedido depois da proposta volta a rascunho e invalida a proposta: o "sim" não confirma o conteúdo velho', async () => {
    const c = ctx('autonomo')
    const add = await pedidoReal.itens(c, { acao: 'adicionar', skuId, quantidade: 1 })
    expect(add.situacao).toBe('ok')
    expect(add.pedido?.totalCentavos).toBe(3990)
    const prop = await pedidoReal.propor(c)
    expect(prop.situacao).toBe('ok')
    const [antes] = await dono<{ estado: string; vigentes: number }[]>`
      SELECT p.estado, (SELECT count(*)::int FROM pedido_proposta pp WHERE pp.tenant_id = p.tenant_id AND pp.pedido_id = p.id AND pp.vigente) AS vigentes
        FROM pedido p WHERE p.tenant_id = ${T}`
    expect(antes).toMatchObject({ estado: 'aguardando_confirmacao', vigentes: 1 })

    // Cliente: "muda para 3" — o agente altera o item.
    const alt = await pedidoReal.itens(c, { acao: 'alterar', seq: 1, quantidade: 3 })
    expect(alt.situacao).toBe('ok')
    const pedidos = await dono<{ estado: string; vigentes: number }[]>`
      SELECT p.estado, (SELECT count(*)::int FROM pedido_proposta pp WHERE pp.tenant_id = p.tenant_id AND pp.pedido_id = p.id AND pp.vigente) AS vigentes
        FROM pedido p WHERE p.tenant_id = ${T}`
    expect(pedidos).toHaveLength(1) // não nasceu um segundo pedido
    expect(pedidos[0]).toMatchObject({ estado: 'rascunho', vigentes: 0 })

    // O "sim" agora NÃO confirma nada (não há pendente).
    const r = await comTenantServico(T, (tx) => confirmarPedidoPorResposta(tx, CONVERSA, 'sim', new Date()))
    expect(r.tipo).not.toBe('confirmado')
  })
})

describe('Pedido de ensaio (sombra/assistido/simulação)', () => {
  it('adiciona com preço real do perfil e saldo, propõe sem enviar — e nenhuma linha nasce em pedido', async () => {
    const c = ctx('sombra')
    const add = await pedidoEnsaio.itens(c, { acao: 'adicionar', skuId, quantidade: 2 })
    expect(add).toMatchObject({ situacao: 'ok', pedido: { totalCentavos: 7980, estado: 'ensaio' } })
    expect(await pedidoEnsaio.itens(c, { acao: 'adicionar', skuId, quantidade: 20 })).toMatchObject({ situacao: 'estoque_insuficiente' })
    const prop = await pedidoEnsaio.propor(c)
    expect(prop.situacao).toBe('ok')
    if (prop.situacao === 'ok') expect(prop.resumo).toMatch(/ensaio/)
    const [n] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM pedido WHERE tenant_id = ${T}`
    expect(n!.n).toBe(0)
    expect((await pedidoEnsaio.ver(c))?.itens[0]?.quantidade).toBe(2)
  })
  it('ligacoesPadrao escolhe o ensaio fora do autônomo e o real no autônomo', async () => {
    const sombra = await ligacoesPadrao({ tenantId: T, politicas: '', modo: 'sombra' })
    const auto = await ligacoesPadrao({ tenantId: T, politicas: '', modo: 'autonomo' })
    expect(sombra.pedido).toBe(pedidoEnsaio)
    expect(auto.pedido).toBe(pedidoReal)
    expect(sombra.catalogo).toBeDefined()
  })
})
