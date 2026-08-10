import { randomUUID } from 'node:crypto'
import type { ConectorErp, SkuCanonico } from '@geracrm/conectores'
import type { Sql } from '../../db/index.js'
import { jsonbDe } from '../../db/jsonb.js'

/**
 * Catalogue ingestion — products and SKUs mirrored from the ERP.
 *
 * ⚠️ The distinction the pdv-core reading made explicit: PRODUCT is not what
 * gets sold. Product is the model ("CONJUNTO LAILA"); the SKU is the
 * colour × size (× sub-size) combination, and that is what has stock and price.
 *
 * Unlike sales, the catalogue is MUTABLE: description changes, items are
 * discontinued. So this reconciles instead of skipping.
 */

export interface RelatorioProdutos {
  lidos: number
  produtosCriados: number
  skusCriados: number
  skusAtualizados: number
  /** ⚠️ Never deleted — a discontinued SKU still appears in old sales, and
   *  removing it would erase history that is legitimately there. */
  skusDesativados: number
  rejeitados: number
  rejeicoes: { idExterno: string; motivo: string }[]
}

const LIMITE_AMOSTRA = 50

export async function ingerirProdutos(
  tx: Sql,
  tenantId: string,
  conexaoId: string,
  conector: ConectorErp,
  opcoes: { maxPaginas?: number; desativarAusentes?: boolean } = {},
): Promise<RelatorioProdutos> {
  const r: RelatorioProdutos = {
    lidos: 0, produtosCriados: 0, skusCriados: 0, skusAtualizados: 0,
    skusDesativados: 0, rejeitados: 0, rejeicoes: [],
  }

  const sistema = `erp:${conexaoId}`
  const vistos = new Set<string>()
  let cursor: string | undefined
  let paginas = 0

  do {
    const pagina = await conector.listarSkus(cursor)
    cursor = pagina.cursor
    paginas += 1

    for (const sku of pagina.itens) {
      r.lidos += 1
      try {
        await ingerirUm(tx, tenantId, sistema, sku, r)
        vistos.add(sku.idExterno)
      } catch (erro) {
        r.rejeitados += 1
        if (r.rejeicoes.length < LIMITE_AMOSTRA) {
          r.rejeicoes.push({
            idExterno: sku.idExterno,
            motivo: erro instanceof Error ? erro.message : String(erro),
          })
        }
      }
    }
  } while (cursor && (!opcoes.maxPaginas || paginas < opcoes.maxPaginas))

  // ⚠️ Only after a COMPLETE sweep. Deactivating on a partial page would turn a
  // network failure halfway through into "the whole catalogue was discontinued".
  const varreduraCompleta = !cursor
  if (opcoes.desativarAusentes && varreduraCompleta && vistos.size > 0) {
    const desativados = await tx<{ sku_id: string }[]>`
      UPDATE sku SET ativo = false
       WHERE tenant_id = ${tenantId} AND ativo = true
         AND id IN (
           SELECT sku_id FROM sku_identidade_externa
            WHERE tenant_id = ${tenantId} AND sistema = ${sistema}
              AND id_externo <> ALL(${[...vistos]}::text[])
         )
      RETURNING id AS sku_id
    `
    r.skusDesativados = desativados.length
  }

  return r
}

async function ingerirUm(
  tx: Sql,
  tenantId: string,
  sistema: string,
  sku: SkuCanonico,
  r: RelatorioProdutos,
): Promise<void> {
  if (!sku.referencia?.trim()) throw new Error('sku sem referência de produto')

  // The product the SKU belongs to. Deduped by reference — the unique index of
  // migration 0013b is what makes re-importing safe.
  const [produto] = await tx<{ id: string; novo: boolean }[]>`
    INSERT INTO produto (tenant_id, id, referencia, descricao)
    VALUES (${tenantId}, ${randomUUID()}, ${sku.referencia}, ${sku.descricao})
    ON CONFLICT (tenant_id, referencia) DO UPDATE
      -- ⚠️ Atualiza a descrição: o nome do produto muda no ERP e a tela do
      --    vendedor precisa mostrar o nome de hoje, não o do dia da carga.
      SET descricao = EXCLUDED.descricao
    -- xmax = 0 distingue linha inserida de linha atualizada no mesmo comando.
    RETURNING id, (xmax = 0) AS novo
  `
  if (produto!.novo) r.produtosCriados += 1

  const [existente] = await tx<{ sku_id: string }[]>`
    SELECT sku_id FROM sku_identidade_externa
     WHERE tenant_id = ${tenantId} AND sistema = ${sistema} AND id_externo = ${sku.idExterno}
  `

  if (existente) {
    await tx`
      UPDATE sku
         SET produto_id    = ${produto!.id},
             -- ⚠️ ::text::jsonb, não ::jsonb. Ver nota em jsonbDe().
             atributos     = ${jsonbDe(sku.atributos)}::text::jsonb,
             codigo_barras = ${sku.codigoBarras ?? null},
             ativo         = ${sku.ativo}
       WHERE tenant_id = ${tenantId} AND id = ${existente.sku_id}
    `
    r.skusAtualizados += 1
    return
  }

  const skuId = randomUUID()
  await tx`
    INSERT INTO sku (tenant_id, id, produto_id, atributos, codigo_barras, ativo)
    VALUES (${tenantId}, ${skuId}, ${produto!.id},
            ${jsonbDe(sku.atributos)}::text::jsonb,
            ${sku.codigoBarras ?? null}, ${sku.ativo})
  `
  await tx`
    INSERT INTO sku_identidade_externa (tenant_id, sku_id, sistema, id_externo)
    VALUES (${tenantId}, ${skuId}, ${sistema}, ${sku.idExterno})
  `
  r.skusCriados += 1
}
