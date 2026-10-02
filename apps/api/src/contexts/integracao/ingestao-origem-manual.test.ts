import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import type { ConectorErp, SkuCanonico } from '@geracrm/conectores'
import { ingerirProdutos } from './ingestao-produtos.js'

/**
 * ⚠️ ORIGEM POR CAMPO (ADR-008/025): o que foi cadastrado À MÃO no CRM, a
 * sincronização do ERP NÃO sobrescreve. O caso que este arquivo prende:
 * a loja cadastra "LAILA" no catálogo próprio; o ERP manda um SKU com a mesma
 * referência; o produto manual fica como está e a rejeição aparece no relatório
 * com motivo — nunca em silêncio.
 *
 * ⚠️ UUIDs e códigos de semente exclusivos deste arquivo.
 */
const T = 'ca7a1092-0000-4000-8000-000000000001'
const PV = 'ca7a1092-1111-4000-8000-000000000001'
const CONEXAO = 'ca7a1092-2222-4000-8000-000000000001'
const PLANO = 'ca7a1092-3333-4000-8000-000000000001'
const MODELO = 'ca7a1092-4444-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 3, onnotice: () => {} })

const conectorFalso = (itens: SkuCanonico[]): ConectorErp => ({
  nome: 'falso',
  capacidades: {
    ingestaoClientes: false, ingestaoProdutos: true, ingestaoPedidos: false,
    cargaHistorica: true, saldoSincrono: false, tabelaPrecoSincrona: false,
    creditoCliente: false, escritaPedido: false, webhookDeVenda: false, fidelidade: false,
  },
  async listarClientes() { return { itens: [] } },
  async listarSkus() { return { itens } },
  async listarVendas() { return { itens: [] } },
})

const sku = (p: Partial<SkuCanonico> & { idExterno: string }): SkuCanonico => ({
  referencia: 'LAILA', descricao: 'CONJUNTO LAILA (ERP)',
  atributos: { cor: 'VERDE', tamanho: 'G' }, ativo: true, ...p,
})

const ingerir = (itens: SkuCanonico[]) =>
  dono.begin((tx) => ingerirProdutos(tx as never, T, CONEXAO, conectorFalso(itens)))

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-ingestao-origem-manual', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-ingestao-origem-manual', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'Loja Origem', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO conexao_erp (tenant_id, id, conector, nome_amigavel, fonte_de_venda)
             VALUES (${T}, ${CONEXAO}, 'falso', 'ERP', true) ON CONFLICT DO NOTHING`
})

beforeEach(async () => {
  await dono`DELETE FROM produto WHERE tenant_id = ${T}`
})

afterAll(async () => {
  await dono`DELETE FROM produto WHERE tenant_id = ${T}`
  await dono`DELETE FROM conexao_erp WHERE tenant_id = ${T}`
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${T}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${T}`
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await dono.end()
})

describe('Sincronização do ERP × catálogo manual', () => {
  it('⚠️ dado produto MANUAL com a referência, quando o ERP sincroniza, então não sobrescreve e rejeita com motivo', async () => {
    const manual = randomUUID()
    await dono`INSERT INTO produto (tenant_id, id, referencia, descricao, descricao_longa, origem)
               VALUES (${T}, ${manual}, 'LAILA', 'Conjunto Laila (cadastro da loja)', 'Texto da loja.', 'manual')`
    const skuManual = randomUUID()
    await dono`INSERT INTO sku (tenant_id, id, produto_id, atributos, origem)
               VALUES (${T}, ${skuManual}, ${manual}, '{"cor":"ROSA","tamanho":"M"}'::jsonb, 'manual')`

    const r = await ingerir([sku({ idExterno: 'S-1' })])

    expect(r).toMatchObject({ lidos: 1, produtosCriados: 0, skusCriados: 0, rejeitados: 1 })
    expect(r.rejeicoes[0]).toMatchObject({ idExterno: 'S-1' })
    expect(r.rejeicoes[0]!.motivo).toContain('manual')

    const [p] = await dono<{ descricao: string; descricao_longa: string; origem: string }[]>`
      SELECT descricao, descricao_longa, origem FROM produto WHERE tenant_id = ${T} AND id = ${manual}`
    expect(p).toEqual({ descricao: 'Conjunto Laila (cadastro da loja)', descricao_longa: 'Texto da loja.', origem: 'manual' })
    const skus = await dono<{ id: string; origem: string }[]>`SELECT id, origem FROM sku WHERE tenant_id = ${T}`
    expect(skus).toEqual([{ id: skuManual, origem: 'manual' }]) // a grade do ERP não entrou
  })

  it('dado produto do ERP, então nasce com origem erp e a sincronização seguinte atualiza o nome', async () => {
    const r1 = await ingerir([sku({ idExterno: 'S-1' })])
    expect(r1).toMatchObject({ produtosCriados: 1, skusCriados: 1, rejeitados: 0 })
    const r2 = await ingerir([sku({ idExterno: 'S-1', descricao: 'CONJUNTO LAILA VERAO' })])
    expect(r2).toMatchObject({ produtosCriados: 0, skusAtualizados: 1, rejeitados: 0 })

    const [p] = await dono<{ descricao: string; origem: string }[]>`SELECT descricao, origem FROM produto WHERE tenant_id = ${T}`
    expect(p).toEqual({ descricao: 'CONJUNTO LAILA VERAO', origem: 'erp' })
    const [s] = await dono<{ origem: string }[]>`SELECT origem FROM sku WHERE tenant_id = ${T}`
    expect(s!.origem).toBe('erp')
  })

  it('dado um manual e um do ERP na mesma carga, então o do ERP entra e o manual é só o rejeitado', async () => {
    await dono`INSERT INTO produto (tenant_id, id, referencia, descricao, origem) VALUES (${T}, ${randomUUID()}, 'LAILA', 'Laila da loja', 'manual')`
    const r = await ingerir([sku({ idExterno: 'S-1' }), sku({ idExterno: 'S-2', referencia: 'BRUNA', descricao: 'CONJUNTO BRUNA' })])
    expect(r).toMatchObject({ lidos: 2, produtosCriados: 1, skusCriados: 1, rejeitados: 1 })
    const produtos = await dono<{ referencia: string; origem: string }[]>`SELECT referencia, origem FROM produto WHERE tenant_id = ${T} ORDER BY 1`
    expect(produtos).toEqual([{ referencia: 'BRUNA', origem: 'erp' }, { referencia: 'LAILA', origem: 'manual' }])
  })
})
