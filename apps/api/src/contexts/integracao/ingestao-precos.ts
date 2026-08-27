import type { ConectorGeraCloud } from '@geracrm/conectores'
import type { Sql } from '../../db/index.js'

/**
 * Ingestão de preços — por SKU e por tabela.
 *
 * ⚠️ Preço é POR TABELA (ADR-019: atacado E varejo). Puxa as tabelas relevantes
 * e, para cada uma, o preço EM LOTE dos SKUs que já temos. Guarda no nosso
 * modelo (`sku_preco`) — a camada de importação traduz a forma do ERP para a
 * nossa, nunca o contrário.
 *
 * ⚠️ Só busca preço de SKU que JÁ existe aqui: o preço se ancora ao catálogo já
 * importado. SKU sem preço é lacuna visível (o painel avisa), não erro.
 */

export interface RelatorioPrecos {
  tabelas: number
  skusComPreco: number
  precosGravados: number
  tabelasProcessadas: { idExterno: string; descricao: string; padrao: boolean; skus: number }[]
}

const LOTE = 200

export async function ingerirPrecos(
  tx: Sql,
  tenantId: string,
  conexaoId: string,
  conector: ConectorGeraCloud,
  opcoes: { apenasPadraoEVarejo?: boolean } = {},
): Promise<RelatorioPrecos> {
  const sistema = `erp:${conexaoId}`
  const r: RelatorioPrecos = { tabelas: 0, skusComPreco: 0, precosGravados: 0, tabelasProcessadas: [] }

  const tabelas = await conector.listarTabelasPreco()
  r.tabelas = tabelas.length

  // ⚠️ Por padrão só as que a operação usa: a padrão (atacado) e a de varejo.
  //    Puxar as 79 tabelas seria carga inútil — o painel usa duas.
  const relevantes = opcoes.apenasPadraoEVarejo === false
    ? tabelas
    : tabelas.filter((t) => t.padrao || /varejo/i.test(t.descricao))

  for (const tabela of relevantes) {
    await tx`
      INSERT INTO tabela_preco (tenant_id, id_externo, descricao, padrao, sistema, proposito, ativa)
      VALUES (${tenantId}, ${tabela.idExterno}, ${tabela.descricao}, ${tabela.padrao}, ${sistema},
              -- ⚠️ O ERP sabe qual tabela é de CUSTO. Descartar isso foi o que
              --    obrigou a escolher preço por semelhança de NOME (0074).
              ${tabela.proposito ?? 'venda'}, ${tabela.ativa ?? true})
      ON CONFLICT (tenant_id, sistema, id_externo)
      DO UPDATE SET descricao = EXCLUDED.descricao, padrao = EXCLUDED.padrao,
                    proposito = EXCLUDED.proposito, ativa = EXCLUDED.ativa, visto_em = now()
    `

    // Os SKUs que temos, com o id externo do ERP (o codigoBarra.id).
    const skus = await tx<{ sku_id: string; id_externo: string }[]>`
      SELECT sie.sku_id, sie.id_externo
        FROM sku_identidade_externa sie
       WHERE sie.tenant_id = ${tenantId} AND sie.sistema = ${sistema}
    `
    const porExterno = new Map(skus.map((s) => [s.id_externo, s.sku_id]))

    let daTabela = 0
    for (let i = 0; i < skus.length; i += LOTE) {
      const lote = skus.slice(i, i + LOTE).map((s) => s.id_externo)
      const precos = await conector.listarPrecos(tabela.idExterno, lote)
      for (const p of precos) {
        const skuId = porExterno.get(p.skuExterno)
        if (!skuId || p.valorCentavos <= 0) continue
        await tx`
          INSERT INTO sku_preco (tenant_id, sku_id, tabela_externa, preco_centavos, apurado_em)
          VALUES (${tenantId}, ${skuId}, ${tabela.idExterno}, ${p.valorCentavos}, now())
          ON CONFLICT (tenant_id, sku_id, tabela_externa)
          DO UPDATE SET preco_centavos = EXCLUDED.preco_centavos, apurado_em = now()
        `
        daTabela += 1
        r.precosGravados += 1
      }
    }
    r.tabelasProcessadas.push({
      idExterno: tabela.idExterno, descricao: tabela.descricao, padrao: tabela.padrao, skus: daTabela,
    })
  }

  const [{ n } = { n: 0 }] = await tx<{ n: number }[]>`
    SELECT count(DISTINCT sku_id)::int AS n FROM sku_preco WHERE tenant_id = ${tenantId}`
  r.skusComPreco = n
  return r
}

/**
 * Carga de saldo — soma o estoque de todas as lojas por SKU.
 *
 * ⚠️ Agrega em memória e SUBSTITUI (não soma no banco): reprocessar não
 * duplica. O saldo é da apuração de agora — o painel mostra a data.
 */
export async function ingerirSaldos(
  tx: Sql,
  tenantId: string,
  conexaoId: string,
  conector: ConectorGeraCloud,
  opcoes: { maxPaginas?: number } = {},
): Promise<{ lidos: number; skusComSaldo: number }> {
  const sistema = `erp:${conexaoId}`
  const soma = new Map<string, number>() // skuExterno → quantidade total
  let cursor: string | undefined
  let paginas = 0
  let lidos = 0

  do {
    const pagina = await conector.listarSaldosEstoque(cursor)
    cursor = pagina.cursor
    paginas += 1
    for (const s of pagina.itens) {
      lidos += 1
      soma.set(s.skuExterno, (soma.get(s.skuExterno) ?? 0) + s.quantidade)
    }
  } while (cursor && (!opcoes.maxPaginas || paginas < opcoes.maxPaginas))

  // Resolve skuExterno → sku_id local e grava.
  const skus = await tx<{ sku_id: string; id_externo: string }[]>`
    SELECT sku_id, id_externo FROM sku_identidade_externa
     WHERE tenant_id = ${tenantId} AND sistema = ${sistema}`
  const porExterno = new Map(skus.map((s) => [s.id_externo, s.sku_id]))

  let gravados = 0
  for (const [externo, quantidade] of soma) {
    const skuId = porExterno.get(externo)
    if (!skuId) continue
    await tx`
      INSERT INTO sku_saldo (tenant_id, sku_id, quantidade, apurado_em)
      VALUES (${tenantId}, ${skuId}, ${quantidade}, now())
      ON CONFLICT (tenant_id, sku_id) DO UPDATE SET quantidade = EXCLUDED.quantidade, apurado_em = now()
    `
    gravados += 1
  }
  return { lidos, skusComSaldo: gravados }
}
