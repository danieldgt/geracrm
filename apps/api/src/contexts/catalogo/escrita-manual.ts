import { randomUUID } from 'node:crypto'
import { PERFIS_PRECO, SISTEMA_MANUAL, type PerfilPreco, type ProdutoEntrada, type SkuEntrada } from '@geracrm/shared'
import type { Sql } from '../../db/index.js'
import { jsonbDe } from '../../db/jsonb.js'

/**
 * ESCRITA DO CATÁLOGO MANUAL — produto, SKU, preço e saldo cadastrados à mão
 * (ADR-025). Tudo sob a transação de tenant de quem chama; nenhuma consulta
 * aqui recebe `tenant_id` de parâmetro.
 *
 * ⚠️ O preço manual entra na MESMA estrutura do preço do ERP: `tabela_preco`
 * com `sistema = 'manual'` e `perfil` DECLARADO, e `sku_preco` apontando para
 * ela. É o que faz `preco-de-venda.ts` cotar um produto manual sem caso
 * especial — e sem uma segunda regra de preço para envelhecer sozinha.
 */

/**
 * Falha de negócio como resultado NOMEADO, não exceção (PED-08): a rota
 * traduz para o código HTTP e a tela ramifica pelo código.
 */
export type FalhaCatalogo =
  | { readonly erro: 'catalogo.referencia_duplicada' }
  | { readonly erro: 'catalogo.produto_nao_encontrado' }
  | { readonly erro: 'catalogo.sku_nao_encontrado' }
  /** Campo que pertence ao ERP num registro de origem ERP (ADR-008). */
  | { readonly erro: 'catalogo.origem_erp'; readonly campos: readonly string[] }

type Resultado<T> = { ok: true; valor: T } | { ok: false; falha: FalhaCatalogo }

const ok = <T>(valor: T): Resultado<T> => ({ ok: true, valor })
const falhou = <T>(falha: FalhaCatalogo): Resultado<T> => ({ ok: false, falha })

/**
 * As duas tabelas de preço manuais do tenant, criadas sob demanda. Idempotente
 * (ON CONFLICT na PK); a declaração de `perfil` é o que as põe na regra de
 * preço de 0077 — por `sistema`, então não colide com a declaração do ERP.
 */
export async function garantirTabelasPrecoManuais(tx: Sql): Promise<void> {
  for (const perfil of PERFIS_PRECO) {
    const descricao = perfil === 'varejo' ? 'Varejo (manual)' : 'Atacado (manual)'
    await tx`
      INSERT INTO tabela_preco (tenant_id, sistema, id_externo, descricao, perfil, proposito, ativa, padrao)
      VALUES (tenant_atual(), ${SISTEMA_MANUAL}, ${perfil}, ${descricao}, ${perfil}, 'venda', true, false)
      ON CONFLICT (tenant_id, sistema, id_externo) DO NOTHING`
  }
}

/** Preços por perfil, em centavos. Perfil AUSENTE = sem preço naquele perfil (apaga o que havia). */
export async function gravarPrecosManuais(
  tx: Sql, skuId: string, precos: NonNullable<SkuEntrada['precos']>,
): Promise<void> {
  await garantirTabelasPrecoManuais(tx)
  const presentes: PerfilPreco[] = []
  for (const perfil of PERFIS_PRECO) {
    const centavos = precos[perfil]
    if (centavos === undefined) continue
    presentes.push(perfil)
    await tx`
      INSERT INTO sku_preco (tenant_id, sku_id, tabela_externa, preco_centavos, apurado_em)
      VALUES (tenant_atual(), ${skuId}, ${perfil}, ${centavos}, now())
      ON CONFLICT (tenant_id, sku_id, tabela_externa)
        DO UPDATE SET preco_centavos = EXCLUDED.preco_centavos, apurado_em = now()`
  }
  // Só as linhas MANUAIS (id_externo = perfil); preço vindo do ERP não é tocado.
  await tx`
    DELETE FROM sku_preco
     WHERE tenant_id = tenant_atual() AND sku_id = ${skuId}
       AND tabela_externa = ANY(${[...PERFIS_PRECO]}::text[])
       AND tabela_externa <> ALL(${presentes}::text[])`
}

/** Saldo manual. `null` = não controla estoque → sem linha (a tela mostra "sob demanda"). */
export async function gravarSaldoManual(tx: Sql, skuId: string, saldo: number | null): Promise<void> {
  if (saldo === null) {
    await tx`DELETE FROM sku_saldo WHERE tenant_id = tenant_atual() AND sku_id = ${skuId} AND origem = 'manual'`
    return
  }
  await tx`
    INSERT INTO sku_saldo (tenant_id, sku_id, quantidade, apurado_em, origem)
    VALUES (tenant_atual(), ${skuId}, ${saldo}, now(), 'manual')
    ON CONFLICT (tenant_id, sku_id)
      DO UPDATE SET quantidade = EXCLUDED.quantidade, apurado_em = now(), origem = 'manual'`
}

export async function criarSkuManual(tx: Sql, produtoId: string, entrada: SkuEntrada): Promise<string> {
  const id = randomUUID()
  await tx`
    INSERT INTO sku (tenant_id, id, produto_id, atributos, codigo_barras, ativo, origem)
    VALUES (tenant_atual(), ${id}, ${produtoId},
            ${jsonbDe(entrada.atributos ?? {})}::text::jsonb,
            ${entrada.codigoBarras ?? null}, ${entrada.ativo ?? true}, 'manual')`
  if (entrada.precos) await gravarPrecosManuais(tx, id, entrada.precos)
  if (entrada.saldo !== undefined) await gravarSaldoManual(tx, id, entrada.saldo)
  return id
}

export async function criarProdutoManual(
  tx: Sql, entrada: ProdutoEntrada & { skus?: readonly SkuEntrada[] | undefined },
): Promise<Resultado<{ id: string; skus: string[] }>> {
  // ⚠️ A referência é única por tenant (0013b) em QUALQUER origem: cadastrar à
  //    mão uma referência que o ERP já trouxe criaria o segundo "CONJUNTO LAILA".
  const [existente] = await tx<{ id: string }[]>`
    SELECT id FROM produto WHERE tenant_id = tenant_atual() AND referencia = ${entrada.referencia}`
  if (existente) return falhou({ erro: 'catalogo.referencia_duplicada' })

  const id = randomUUID()
  await tx`
    INSERT INTO produto (tenant_id, id, referencia, descricao, descricao_longa, categoria, imagens, ativo, origem)
    VALUES (tenant_atual(), ${id}, ${entrada.referencia}, ${entrada.descricao},
            ${entrada.descricaoLonga ?? null}, ${entrada.categoria ?? null},
            ${jsonbDe(entrada.imagens ?? [])}::text::jsonb, ${entrada.ativo ?? true}, 'manual')`
  const skus: string[] = []
  for (const s of entrada.skus ?? []) skus.push(await criarSkuManual(tx, id, s))
  return ok({ id, skus })
}

/** Campos de produto que pertencem ao ERP quando `origem = 'erp'`. */
const CAMPOS_DO_ERP_NO_PRODUTO: readonly (keyof ProdutoEntrada)[] = ['referencia', 'descricao', 'ativo']

/** `produtoEntrada.partial()` — com `exactOptionalPropertyTypes`, `Partial<>` não aceita `undefined` explícito. */
export type ProdutoAtualizacao = { [K in keyof ProdutoEntrada]?: ProdutoEntrada[K] | undefined }

export async function atualizarProduto(
  tx: Sql, produtoId: string, entrada: ProdutoAtualizacao,
): Promise<Resultado<{ id: string }>> {
  const [atual] = await tx<{ origem: string; referencia: string }[]>`
    SELECT origem, referencia FROM produto WHERE tenant_id = tenant_atual() AND id = ${produtoId}`
  if (!atual) return falhou({ erro: 'catalogo.produto_nao_encontrado' })

  if (atual.origem === 'erp') {
    const vetados = CAMPOS_DO_ERP_NO_PRODUTO.filter((c) => entrada[c] !== undefined)
    if (vetados.length > 0) return falhou({ erro: 'catalogo.origem_erp', campos: vetados })
  }
  if (entrada.referencia !== undefined && entrada.referencia !== atual.referencia) {
    const [outro] = await tx<{ id: string }[]>`
      SELECT id FROM produto WHERE tenant_id = tenant_atual() AND referencia = ${entrada.referencia} AND id <> ${produtoId}`
    if (outro) return falhou({ erro: 'catalogo.referencia_duplicada' })
  }

  await tx`
    UPDATE produto
       SET referencia      = coalesce(${entrada.referencia ?? null}, referencia),
           descricao       = coalesce(${entrada.descricao ?? null}, descricao),
           ativo           = coalesce(${entrada.ativo ?? null}, ativo),
           categoria       = ${entrada.categoria === undefined ? tx`categoria` : tx`${entrada.categoria || null}`},
           descricao_longa = ${entrada.descricaoLonga === undefined ? tx`descricao_longa` : tx`${entrada.descricaoLonga || null}`},
           imagens         = ${entrada.imagens === undefined ? tx`imagens` : tx`${jsonbDe(entrada.imagens)}::text::jsonb`},
           atualizado_em   = now()
     WHERE tenant_id = tenant_atual() AND id = ${produtoId}`
  return ok({ id: produtoId })
}

/** Desativa, nunca apaga: o produto ainda aparece em pedidos antigos. */
export async function desativarProduto(tx: Sql, produtoId: string): Promise<Resultado<{ id: string }>> {
  const [atual] = await tx<{ origem: string }[]>`
    SELECT origem FROM produto WHERE tenant_id = tenant_atual() AND id = ${produtoId}`
  if (!atual) return falhou({ erro: 'catalogo.produto_nao_encontrado' })
  if (atual.origem === 'erp') return falhou({ erro: 'catalogo.origem_erp', campos: ['ativo'] })
  await tx`UPDATE produto SET ativo = false, atualizado_em = now() WHERE tenant_id = tenant_atual() AND id = ${produtoId}`
  return ok({ id: produtoId })
}

export async function adicionarSku(
  tx: Sql, produtoId: string, entrada: SkuEntrada,
): Promise<Resultado<{ id: string }>> {
  const [produto] = await tx<{ origem: string }[]>`
    SELECT origem FROM produto WHERE tenant_id = tenant_atual() AND id = ${produtoId}`
  if (!produto) return falhou({ erro: 'catalogo.produto_nao_encontrado' })
  // A grade de um produto do ERP é do ERP: SKU novo nasce lá e chega pela sincronização.
  if (produto.origem === 'erp') return falhou({ erro: 'catalogo.origem_erp', campos: ['skus'] })
  return ok({ id: await criarSkuManual(tx, produtoId, entrada) })
}

export async function atualizarSku(
  tx: Sql, produtoId: string, skuId: string, entrada: SkuEntrada,
): Promise<Resultado<{ id: string }>> {
  const [sku] = await tx<{ origem: string }[]>`
    SELECT origem FROM sku WHERE tenant_id = tenant_atual() AND id = ${skuId} AND produto_id = ${produtoId}`
  if (!sku) return falhou({ erro: 'catalogo.sku_nao_encontrado' })
  // ⚠️ SKU do ERP é somente leitura por aqui — inclusive preço e saldo. Um preço
  //    manual por cima de um SKU do ERP faria duas tabelas declaradas disputarem
  //    a cotação (0077), que é o que aquela migration existe para impedir.
  if (sku.origem === 'erp') {
    const campos = (Object.keys(entrada) as (keyof SkuEntrada)[]).filter((c) => entrada[c] !== undefined)
    return falhou({ erro: 'catalogo.origem_erp', campos })
  }

  await tx`
    UPDATE sku
       SET atributos     = ${entrada.atributos === undefined ? tx`atributos` : tx`${jsonbDe(entrada.atributos)}::text::jsonb`},
           codigo_barras = ${entrada.codigoBarras === undefined ? tx`codigo_barras` : tx`${entrada.codigoBarras || null}`},
           ativo         = coalesce(${entrada.ativo ?? null}, ativo)
     WHERE tenant_id = tenant_atual() AND id = ${skuId}`
  if (entrada.precos) await gravarPrecosManuais(tx, skuId, entrada.precos)
  if (entrada.saldo !== undefined) await gravarSaldoManual(tx, skuId, entrada.saldo)
  return ok({ id: skuId })
}

export async function desativarSku(tx: Sql, produtoId: string, skuId: string): Promise<Resultado<{ id: string }>> {
  return atualizarSku(tx, produtoId, skuId, { ativo: false })
}
