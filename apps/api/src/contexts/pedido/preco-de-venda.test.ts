import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { comTenantServico, encerrarBanco } from '../../db/index.js'
import { precosDeVenda } from './preco-de-venda.js'

/**
 * A REGRA DE PREÇO PELA FUNÇÃO — a mesma que `preco-perfil.test.ts` prova pela
 * rota do catálogo.
 *
 * ⚠️ Os dois arquivos testam a MESMA regra de propósito, por portas diferentes.
 * A regra esteve escrita duas vezes em SQL e ia nascer uma terceira no agente;
 * agora é uma função só, e este par de suítes é o que denuncia se um dos
 * caminhos voltar a ter opinião própria sobre quanto o cliente paga.
 *
 * ⚠️ Roda sob `comTenantServico`, que conecta com o papel `geracrm_api` — o
 * mesmo caminho do webhook e do worker, que é por onde o agente vai chamar.
 * Testar isolamento com a conexão de dono passa sempre e não prova nada.
 */
const A = 'c7ed0000-0000-4000-8000-000000000001'
const B = 'c7ed0000-0000-4000-8000-000000000002'
const PVA = 'c7ed0000-1111-4000-8000-000000000001'
const PVB = 'c7ed0000-1111-4000-8000-000000000002'
const PLANO = 'c7ed0000-3333-4000-8000-000000000001'
const MODELO = 'c7ed0000-4444-4000-8000-000000000001'
const PROD_A = 'c7ed0000-5555-4000-8000-00000000000a'
const PROD_B = 'c7ed0000-5555-4000-8000-00000000000b'
const SKU_A = 'c7ed0000-6666-4000-8000-00000000000a'
const SKU_B = 'c7ed0000-6666-4000-8000-00000000000b'
const SKU_INEXISTENTE = 'c7ed0000-6666-4000-8000-0000000000ff'
const SISTEMA = 'erp:teste-preco-de-venda'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance

/** Uma tabela do ERP com preço para o SKU do tenant. */
const tabela = (
  tenant: string, sku: string, idExterno: string, descricao: string,
  proposito: string, ativa: boolean, centavos: number, perfil: string | null = null,
) =>
  dono.begin(async (tx) => {
    await tx`INSERT INTO tabela_preco (tenant_id, id_externo, descricao, padrao, sistema, proposito, ativa, perfil)
             VALUES (${tenant}, ${idExterno}, ${descricao}, false, ${SISTEMA}, ${proposito}, ${ativa}, ${perfil})
             ON CONFLICT (tenant_id, sistema, id_externo) DO UPDATE
               SET descricao = EXCLUDED.descricao, proposito = EXCLUDED.proposito,
                   ativa = EXCLUDED.ativa, perfil = EXCLUDED.perfil`
    await tx`INSERT INTO sku_preco (tenant_id, sku_id, tabela_externa, preco_centavos)
             VALUES (${tenant}, ${sku}, ${idExterno}, ${centavos})
             ON CONFLICT (tenant_id, sku_id, tabela_externa) DO UPDATE SET preco_centavos = EXCLUDED.preco_centavos`
  })

const cotar = (tenant: string, ids: readonly string[], perfil: 'varejo' | 'atacado' = 'varejo') =>
  comTenantServico(tenant, (tx) => precosDeVenda(tx, ids, perfil))

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-preco-de-venda', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-preco-de-venda', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[A, PVA, 'Loja A'], [B, PVB, 'Loja B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id)
               VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome)
               VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  for (const [t, prod, sku] of [[A, PROD_A, SKU_A], [B, PROD_B, SKU_B]] as const) {
    await dono`INSERT INTO produto (tenant_id, id, referencia, descricao)
               VALUES (${t}, ${prod}, 'REF-1', 'Camisa') ON CONFLICT DO NOTHING`
    await dono`INSERT INTO sku (tenant_id, id, produto_id, atributos)
               VALUES (${t}, ${sku}, ${prod}, '{"cor":"Azul"}'::jsonb) ON CONFLICT DO NOTHING`
  }
  app = await criarApp(); await app.ready()
})

afterAll(async () => {
  for (const t of [A, B]) {
    await dono`DELETE FROM sku_preco    WHERE tenant_id = ${t}`
    await dono`DELETE FROM tabela_preco WHERE tenant_id = ${t}`
    await dono`DELETE FROM sku          WHERE tenant_id = ${t}`
    await dono`DELETE FROM produto      WHERE tenant_id = ${t}`
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant       WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

beforeEach(async () => {
  for (const t of [A, B]) {
    await dono`DELETE FROM sku_preco    WHERE tenant_id = ${t}`
    await dono`DELETE FROM tabela_preco WHERE tenant_id = ${t}`
  }
})

describe('Cotação de SKU conhecido', () => {
  it('dado tabela de venda ativa do perfil, então cota em centavos inteiros', async () => {
    await tabela(A, SKU_A, '100', 'TABELA VAREJO', 'venda', true, 8900)
    expect((await cotar(A, [SKU_A])).get(SKU_A)).toEqual({ situacao: 'cotado', centavos: 8900 })
  })

  /** ⚠️ O caso caro: o nome casa, mas o ERP diz que é custo (0074). */
  it('dado tabela de CUSTO com nome do perfil, então NÃO cota a margem da loja', async () => {
    await tabela(A, SKU_A, '101', 'Custo Varejo', 'custo', true, 1000)
    expect((await cotar(A, [SKU_A])).get(SKU_A)).toEqual({ situacao: 'sem_preco' })
  })

  it('dado tabela desativada no ERP, então não cota preço velho', async () => {
    await tabela(A, SKU_A, '102', 'TABELA VAREJO ANTIGA', 'venda', false, 5000)
    expect((await cotar(A, [SKU_A])).get(SKU_A)).toEqual({ situacao: 'sem_preco' })
  })

  /** ⚠️ 0077: renomear no ERP não pode mudar o preço em silêncio. */
  it('dado perfil DECLARADO, então a declaração ganha do nome', async () => {
    await tabela(A, SKU_A, '103', 'TABELA VAREJO', 'venda', true, 9900)              // casa por nome
    await tabela(A, SKU_A, '104', 'PROMOCAO ESPECIAL', 'venda', true, 7700, 'varejo') // declarada
    expect((await cotar(A, [SKU_A])).get(SKU_A)).toEqual({ situacao: 'cotado', centavos: 7700 })
  })

  it('dado perfil sem tabela nenhuma, então sem preço — nunca o preço do outro perfil', async () => {
    await tabela(A, SKU_A, '105', 'TABELA VAREJO', 'venda', true, 9900)
    expect((await cotar(A, [SKU_A], 'atacado')).get(SKU_A)).toEqual({ situacao: 'sem_preco' })
  })
})

/**
 * ⚠️ A distinção que o `number | null` apagava. Para o agente ela é a diferença
 * entre "não achei esse produto" (pergunta ao cliente) e "achei, mas ninguém
 * configurou o preço" (chama o humano) — ações corretivas diferentes, PED-08.
 */
describe('Sem preço ≠ SKU desconhecido', () => {
  it('dado id que não existe, então sku_desconhecido', async () => {
    expect((await cotar(A, [SKU_INEXISTENTE])).get(SKU_INEXISTENTE)).toEqual({ situacao: 'sku_desconhecido' })
  })

  it('dado SKU inativo, então sku_desconhecido — não entra em prévia de pedido', async () => {
    await tabela(A, SKU_A, '106', 'TABELA VAREJO', 'venda', true, 8900)
    await dono`UPDATE sku SET ativo = false WHERE tenant_id = ${A} AND id = ${SKU_A}`
    try {
      expect((await cotar(A, [SKU_A])).get(SKU_A)).toEqual({ situacao: 'sku_desconhecido' })
    } finally {
      await dono`UPDATE sku SET ativo = true WHERE tenant_id = ${A} AND id = ${SKU_A}`
    }
  })

  /** ⚠️ Uma entrada por id PEDIDO: ausência de chave nunca é resposta. */
  it('dado ids repetidos e desconhecidos juntos, então responde por todos', async () => {
    await tabela(A, SKU_A, '107', 'TABELA VAREJO', 'venda', true, 8900)
    const r = await cotar(A, [SKU_A, SKU_A, SKU_INEXISTENTE])
    expect(r.size).toBe(2)
    expect(r.get(SKU_A)).toEqual({ situacao: 'cotado', centavos: 8900 })
    expect(r.get(SKU_INEXISTENTE)).toEqual({ situacao: 'sku_desconhecido' })
  })

  it('dado lista vazia, então não consulta o banco à toa', async () => {
    expect((await cotar(A, [])).size).toBe(0)
  })

  /** Defeito de programação, não falha de negócio: quem chama montou a lista. */
  it('dado lista acima do teto, então recusa em vez de varrer a base', async () => {
    const muitos = Array.from({ length: 201 }, (_, i) => `c7ed0000-6666-4000-8000-${String(i).padStart(12, '0')}`)
    await expect(cotar(A, muitos)).rejects.toThrow(/teto/)
  })
})

/**
 * ⚠️ O caso obrigatório de todo acesso a dado (ADR-001). Aqui ele é mais que
 * formal: um vazamento nesta função mostraria o preço praticado por uma loja
 * dentro da conversa de outra.
 */
describe('Isolamento entre tenants', () => {
  it('dado SKU do tenant B, quando o tenant A cota, então sku_desconhecido', async () => {
    await tabela(B, SKU_B, '108', 'TABELA VAREJO', 'venda', true, 4200)
    expect((await cotar(A, [SKU_B])).get(SKU_B)).toEqual({ situacao: 'sku_desconhecido' })
    expect((await cotar(B, [SKU_B])).get(SKU_B)).toEqual({ situacao: 'cotado', centavos: 4200 })
  })

  it('dado tabela do tenant B com o mesmo id externo, então o preço não atravessa', async () => {
    await tabela(A, SKU_A, '109', 'TABELA VAREJO', 'venda', true, 8900)
    await tabela(B, SKU_B, '109', 'TABELA VAREJO', 'venda', true, 100)
    expect((await cotar(A, [SKU_A])).get(SKU_A)).toEqual({ situacao: 'cotado', centavos: 8900 })
  })
})

/**
 * ⚠️ O TESTE QUE JUSTIFICA A EXTRAÇÃO. Enquanto a regra estava copiada, nada
 * comparava as duas respostas — a divergência só apareceria no WhatsApp do
 * cliente. Aqui a função e a rota do catálogo cotam o mesmo SKU, e o número tem
 * de bater nos casos em que a cópia mais provavelmente envelheceria.
 */
describe('⚠️ A função e a rota do catálogo cotam o mesmo número', () => {
  const doCatalogo = async (perfil: string): Promise<number | null> => {
    const r = await app.inject({ method: 'GET', url: `/v1/catalogo?perfil=${perfil}`, headers: { 'x-tenant-id': A } })
    const corpo = r.json() as { itens?: { skus?: { precoCentavos: number | null }[] }[] }
    return corpo.itens?.[0]?.skus?.[0]?.precoCentavos ?? null
  }
  const daFuncao = async (perfil: 'varejo' | 'atacado'): Promise<number | null> => {
    const p = (await cotar(A, [SKU_A], perfil)).get(SKU_A)
    return p?.situacao === 'cotado' ? p.centavos : null
  }

  it('com tabela declarada ao lado da que casa por nome', async () => {
    await tabela(A, SKU_A, '110', 'TABELA VAREJO', 'venda', true, 9900)
    await tabela(A, SKU_A, '111', 'PROMOCAO ESPECIAL', 'venda', true, 7700, 'varejo')
    expect(await daFuncao('varejo')).toBe(7700)
    expect(await doCatalogo('varejo')).toBe(await daFuncao('varejo'))
  })

  it('com tabela de custo no meio', async () => {
    await tabela(A, SKU_A, '112', 'Custo Varejo', 'custo', true, 1000)
    await tabela(A, SKU_A, '113', 'TABELA VAREJO', 'venda', true, 8900)
    expect(await daFuncao('varejo')).toBe(8900)
    expect(await doCatalogo('varejo')).toBe(await daFuncao('varejo'))
  })

  it('e concordam também quando não há preço', async () => {
    await tabela(A, SKU_A, '114', 'TABELA VAREJO', 'venda', true, 9900)
    expect(await daFuncao('atacado')).toBeNull()
    expect(await doCatalogo('atacado')).toBeNull()
  })
})
