import { randomUUID } from 'node:crypto'
import type { ConectorErp, VendaCanonica } from '@geracrm/conectores'
import type { Sql } from '../../db/index.js'

/**
 * Sales ingestion — what feeds RFV, repurchase and revenue attribution.
 *
 * ⚠️ Sales are IMMUTABLE here. If one already exists, it is skipped, not
 * updated: the ERP owns the number, and rewriting it would mean the CRM
 * disagreeing with the customer's own revenue.
 */

export interface RelatorioVendas {
  lidos: number
  importadas: number
  jaExistiam: number
  rejeitadas: number
  /** ⚠️ Sales whose customer we could not resolve. They still count towards
   *  revenue, but they do NOT enter RFV — and that gap has to be visible,
   *  otherwise "the totals don't match the ERP" has no explanation. */
  semContato: number
  /** ⚠️ Importadas com a data de cancelamento: entram para conciliar, ficam
   *  fora do RFV e fora do valorTotalCentavos. Visíveis para explicar por que a
   *  contagem de linhas é maior que o total válido. */
  canceladas: number
  vendedoresPendentes: number
  valorTotalCentavos: number
  rejeicoes: { idExterno: string; motivo: string }[]
}

const LIMITE_AMOSTRA = 50

export async function ingerirVendas(
  tx: Sql,
  tenantId: string,
  conexaoId: string,
  conector: ConectorErp,
  desde: Date,
  opcoes: { maxPaginas?: number } = {},
): Promise<RelatorioVendas> {
  const r: RelatorioVendas = {
    lidos: 0, importadas: 0, jaExistiam: 0, rejeitadas: 0,
    semContato: 0, canceladas: 0, vendedoresPendentes: 0, valorTotalCentavos: 0, rejeicoes: [],
  }

  const sistema = `erp:${conexaoId}`
  let cursor: string | undefined
  let paginas = 0

  do {
    const pagina = await conector.listarVendas(desde, cursor)
    cursor = pagina.cursor
    paginas += 1

    for (const venda of pagina.itens) {
      r.lidos += 1
      try {
        await ingerirUma(tx, tenantId, conexaoId, sistema, venda, r)
      } catch (erro) {
        r.rejeitadas += 1
        if (r.rejeicoes.length < LIMITE_AMOSTRA) {
          r.rejeicoes.push({
            idExterno: venda.idExterno,
            motivo: erro instanceof Error ? erro.message : String(erro),
          })
        }
      }
    }
  } while (cursor && (!opcoes.maxPaginas || paginas < opcoes.maxPaginas))

  return r
}

async function ingerirUma(
  tx: Sql,
  tenantId: string,
  conexaoId: string,
  sistema: string,
  venda: VendaCanonica,
  r: RelatorioVendas,
): Promise<void> {
  if (!Number.isFinite(venda.valorCentavos)) throw new Error('venda sem valor')
  if (!(venda.ocorridaEm instanceof Date) || Number.isNaN(venda.ocorridaEm.getTime())) {
    throw new Error('venda sem data válida')
  }

  // Idempotency guard. ⚠️ Not partitioned on purpose — the uniqueness must hold
  // forever, so re-importing an old month cannot duplicate the sale.
  const [existente] = await tx<{ venda_id: string }[]>`
    SELECT venda_id FROM venda_identidade_externa
     WHERE tenant_id = ${tenantId} AND sistema = ${sistema} AND id_externo = ${venda.idExterno}
  `
  if (existente) {
    r.jaExistiam += 1
    return
  }

  // Resolve the customer through the identity the customer ingestion created.
  const [contato] = await tx<{ contato_id: string }[]>`
    SELECT contato_id FROM contato_identidade_externa
     WHERE tenant_id = ${tenantId} AND sistema = ${sistema} AND id_externo = ${venda.clienteExterno}
  `
  if (!contato) r.semContato += 1

  let usuarioId: string | null = null
  if (venda.vendedorExterno) {
    const [u] = await tx<{ usuario_id: string }[]>`
      SELECT usuario_id FROM usuario_identidade_externa
       WHERE tenant_id = ${tenantId} AND conexao_id = ${conexaoId} AND id_externo = ${venda.vendedorExterno}
    `
    if (u) {
      usuarioId = u.usuario_id
    } else {
      r.vendedoresPendentes += 1
      // Same rule as customer ingestion: never drop the name silently, or the
      // salesperson simply does not appear in the ranking and nobody notices.
      await tx`
        INSERT INTO correspondencia_pendente (tenant_id, conexao_id, tipo, id_externo)
        VALUES (${tenantId}, ${conexaoId}, 'usuario', ${venda.vendedorExterno})
        ON CONFLICT (tenant_id, conexao_id, tipo, id_externo)
        DO UPDATE SET ocorrencias = correspondencia_pendente.ocorrencias + 1, ultimo_em = now()
      `
    }
  }

  const vendaId = randomUUID()
  await tx`
    INSERT INTO venda (tenant_id, id, contato_id, ocorrida_em, valor_centavos,
                       usuario_id, vendedor_externo, filial_externa, cancelada_em)
    VALUES (${tenantId}, ${vendaId}, ${contato?.contato_id ?? null}, ${venda.ocorridaEm},
            ${venda.valorCentavos}, ${usuarioId},
            ${venda.vendedorExterno ?? null}, ${venda.filialExterna ?? null},
            -- ⚠️ Cancelada entra, mas com a data: o RFV a exclui (a MV filtra
            --    cancelada_em IS NULL) e a conciliação ainda a conta.
            ${venda.canceladaEm ?? null})
  `

  let seq = 0
  for (const item of venda.itens) {
    seq += 1
    const [sku] = await tx<{ sku_id: string }[]>`
      SELECT sku_id FROM sku_identidade_externa
       WHERE tenant_id = ${tenantId} AND sistema = ${sistema} AND id_externo = ${item.skuExterno}
    `
    await tx`
      INSERT INTO item_venda (tenant_id, venda_id, venda_ocorrida_em, seq,
                              sku_id, sku_externo, quantidade, valor_unitario_centavos)
      VALUES (${tenantId}, ${vendaId}, ${venda.ocorridaEm}, ${seq},
              ${sku?.sku_id ?? null}, ${item.skuExterno},
              ${item.quantidade}, ${item.valorUnitarioCentavos})
    `
  }

  await tx`
    INSERT INTO venda_identidade_externa (tenant_id, sistema, id_externo, venda_id, venda_ocorrida_em)
    VALUES (${tenantId}, ${sistema}, ${venda.idExterno}, ${vendaId}, ${venda.ocorridaEm})
  `

  // ⚠️ Contadores desnormalizados NÃO contam venda cancelada — senão o
  //    contato.qtd_vendas divergiria da MV (que filtra cancelada_em IS NULL) e o
  //    kanban ordenaria por um número que a ficha do cliente contradiz.
  if (contato && !venda.canceladaEm) {
    await tx`
      UPDATE contato
         SET qtd_vendas            = qtd_vendas + 1,
             total_vendas_centavos = total_vendas_centavos + ${venda.valorCentavos},
             primeira_venda_em     = least(coalesce(primeira_venda_em, ${venda.ocorridaEm}), ${venda.ocorridaEm}),
             ultima_venda_em       = greatest(coalesce(ultima_venda_em, ${venda.ocorridaEm}), ${venda.ocorridaEm})
       WHERE tenant_id = ${tenantId} AND id = ${contato.contato_id}
    `
  }

  r.importadas += 1
  if (venda.canceladaEm) {
    r.canceladas += 1
  } else {
    // ⚠️ O total do relatório é o de vendas VÁLIDAS — é ele que a conciliação
    //    compara com o faturamento do ERP. Somar cancelada aqui faria o CRM
    //    parecer maior que o ERP sem explicação.
    r.valorTotalCentavos += venda.valorCentavos
  }
}
