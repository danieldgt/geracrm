import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'

/**
 * ⚠️ QUAL TABELA DE PREÇO O CATÁLOGO USA — e, sobretudo, qual ele NUNCA usa.
 *
 * A escolha era feita por semelhança de NOME, com remendos (`NOT ILIKE
 * '%teste%'`), porque a ingestão descartava o `tipo` e o `status` que o ERP já
 * dava. Bastava existir uma tabela chamada "Custo Varejo" para o produto cotar
 * o CUSTO a um cliente numa conversa de WhatsApp — expondo a margem da loja.
 *
 * Medido no ERP de produção em 2026-08-27: das 24 tabelas, 6 ativas e 3 delas de
 * CUSTO. Este teste existe para que o filtro não seja removido "para
 * simplificar" — o sintoma da remoção aparece no cliente, não no CI.
 */
const T = 'b9ec0000-0000-4000-8000-000000000001'
const PV = 'b9ec0000-1111-4000-8000-000000000001'
const PLANO = 'b9ec0000-3333-4000-8000-000000000001'
const MODELO = 'b9ec0000-4444-4000-8000-000000000001'
const PROD = 'b9ec0000-5555-4000-8000-000000000001'
const SKU = 'b9ec0000-6666-4000-8000-000000000001'
const SISTEMA = 'erp:teste-preco'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const catalogo = (perfil: string) =>
  app.inject({ method: 'GET', url: `/v1/catalogo?perfil=${perfil}`, headers: { 'x-tenant-id': T } })

/** Uma tabela do ERP com preço para o nosso SKU. */
const tabela = (idExterno: string, descricao: string, proposito: string, ativa: boolean, centavos: number) =>
  dono.begin(async (tx) => {
    await tx`INSERT INTO tabela_preco (tenant_id, id_externo, descricao, padrao, sistema, proposito, ativa)
             VALUES (${T}, ${idExterno}, ${descricao}, false, ${SISTEMA}, ${proposito}, ${ativa})
             ON CONFLICT (tenant_id, sistema, id_externo) DO UPDATE
               SET descricao = EXCLUDED.descricao, proposito = EXCLUDED.proposito, ativa = EXCLUDED.ativa`
    await tx`INSERT INTO sku_preco (tenant_id, sku_id, tabela_externa, preco_centavos)
             VALUES (${T}, ${SKU}, ${idExterno}, ${centavos})
             ON CONFLICT (tenant_id, sku_id, tabela_externa) DO UPDATE SET preco_centavos = EXCLUDED.preco_centavos`
  })

const precoDoSku = async (perfil: string): Promise<number | null> => {
  const corpo = (await catalogo(perfil)).json() as { itens?: { skus?: { precoCentavos: number | null }[] }[] }
  return corpo.itens?.[0]?.skus?.[0]?.precoCentavos ?? null
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-preco-perfil', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-preco-perfil', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'Loja Preço', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO produto (tenant_id, id, referencia, descricao) VALUES (${T}, ${PROD}, 'REF-1', 'Camisa') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO sku (tenant_id, id, produto_id, atributos) VALUES (${T}, ${SKU}, ${PROD}, '{"cor":"Azul"}'::jsonb) ON CONFLICT DO NOTHING`
  app = await criarApp(); await app.ready()
})

afterAll(async () => {
  await dono`DELETE FROM sku_preco    WHERE tenant_id = ${T}`
  await dono`DELETE FROM tabela_preco WHERE tenant_id = ${T}`
  await dono`DELETE FROM sku          WHERE tenant_id = ${T}`
  await dono`DELETE FROM produto      WHERE tenant_id = ${T}`
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${T}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${T}`
  await dono`DELETE FROM tenant       WHERE id = ${T}`
  await dono`DELETE FROM plano        WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('⚠️ Tabela de CUSTO nunca é cotada ao cliente', () => {
  /**
   * O caso caro: o nome casa com o perfil, mas o ERP diz que é custo. Antes do
   * 0074 o produto olhava só o nome — e cotaria a margem da loja.
   */
  it('"Custo Varejo" não vira preço, mesmo casando com o perfil', async () => {
    await tabela('900', 'Custo Varejo', 'custo', true, 1000)
    expect(await precoDoSku('varejo')).toBeNull()
  })

  it('com a de venda ao lado, é a de VENDA que vale', async () => {
    await tabela('900', 'Custo Varejo', 'custo', true, 1000)
    await tabela('901', 'TABELA VAREJO', 'venda', true, 8900)
    expect(await precoDoSku('varejo')).toBe(8900)
  })
})

describe('⚠️ Tabela desativada no ERP não cota', () => {
  it('tabela de venda inativa é ignorada', async () => {
    await dono`DELETE FROM sku_preco WHERE tenant_id = ${T}`
    await dono`DELETE FROM tabela_preco WHERE tenant_id = ${T}`
    await tabela('902', 'TABELA VAREJO ANTIGA', 'venda', false, 5000)
    expect(await precoDoSku('varejo')).toBeNull()
  })
})

describe('Perfil separa atacado de varejo (ADR-019)', () => {
  it('cada perfil pega a sua tabela', async () => {
    await dono`DELETE FROM sku_preco WHERE tenant_id = ${T}`
    await dono`DELETE FROM tabela_preco WHERE tenant_id = ${T}`
    await tabela('903', 'TABELA VAREJO', 'venda', true, 9900)
    await tabela('904', 'TABELA ATACADO', 'venda', true, 4900)
    expect(await precoDoSku('varejo')).toBe(9900)
    expect(await precoDoSku('atacado')).toBe(4900)
  })

  /**
   * ⚠️ Sem tabela para o perfil, o preço é NULO e a tela mostra "sem preço" —
   * nunca um número inventado. É o estado real do atacado no ERP de produção
   * hoje: nenhuma tabela ativa casa com o nome.
   */
  it('perfil sem tabela devolve sem preço, não o preço do outro perfil', async () => {
    await dono`DELETE FROM sku_preco WHERE tenant_id = ${T}`
    await dono`DELETE FROM tabela_preco WHERE tenant_id = ${T}`
    await tabela('905', 'TABELA VAREJO', 'venda', true, 9900)
    expect(await precoDoSku('atacado')).toBeNull()
  })
})
