import { createHash } from 'node:crypto'
import { textoParaIndice, type AtributosSku } from '@geracrm/shared'
import type { Sql } from '../../db/index.js'

/**
 * INDEXADOR DO CATÁLOGO — mantém `produto_indice` (0088) em dia.
 *
 * Uma linha por produto, com o texto de `textoParaIndice()` (shared): referência,
 * nome, categoria, descrição longa e os VALORES de atributo dos SKUs ativos.
 * ⚠️ Nunca preço nem saldo — mudam sozinhos e variam por tabela do cliente.
 *
 * Idempotente por hash: texto igual → nada é gravado, e o embedding (quando
 * houver) continua válido. Texto diferente → regrava e ZERA `modelo_embedding`,
 * que é como o passo de embedding sabe o que refazer.
 *
 * ⚠️ `tenantId` explícito é para o WORKER (dono do banco, sem tenant de
 * sessão — ADR-015). Em rota, fica ausente e vale `tenant_atual()`; a RLS
 * continua decidindo o que cada papel enxerga.
 */

export type ResultadoIndexacao = 'indexado' | 'inalterado' | 'nao_encontrado'

export interface RelatorioReindexacao {
  indexados: number
  inalterados: number
  /** Produtos sem índice que não foram encontrados (apagados entre o cursor e a leitura). */
  ausentes: number
}

const LOTE_PADRAO = 200
const LOTE_MAX = 1000

function hashDe(texto: string): string {
  return createHash('sha256').update(texto).digest('hex')
}

interface LinhaProduto {
  id: string
  referencia: string
  descricao: string
  descricao_longa: string | null
  categoria: string | null
  atributos: AtributosSku[]
}

async function lerProdutos(tx: Sql, ids: readonly string[], tenantId: string | undefined): Promise<LinhaProduto[]> {
  return tx<LinhaProduto[]>`
    SELECT p.id, p.referencia, p.descricao, p.descricao_longa, p.categoria,
           coalesce((SELECT json_agg(s.atributos ORDER BY s.atributos::text)
                       FROM sku s
                      WHERE s.tenant_id = p.tenant_id AND s.produto_id = p.id AND s.ativo),
                    '[]'::json) AS atributos
      FROM produto p
     WHERE p.tenant_id = coalesce(${tenantId ?? null}::uuid, tenant_atual())
       AND p.id = ANY(${[...ids]}::uuid[])`
}

/**
 * Grava (ou confirma) o índice de um lote de produtos já lidos. Devolve quantos
 * mudaram. Um comando por produto: o lote é pequeno e o hash poupa a maioria.
 */
async function gravarIndice(tx: Sql, produtos: readonly LinhaProduto[], tenantId: string | undefined)
  : Promise<{ indexados: number; inalterados: number }> {
  let indexados = 0
  let inalterados = 0
  for (const p of produtos) {
    // ⚠️ Mapeado campo a campo: a linha vem em snake_case e o contrato do
    //    shared é camelCase — passar `p` direto deixava a descrição longa de fora.
    const texto = textoParaIndice({
      referencia: p.referencia, descricao: p.descricao, descricaoLonga: p.descricao_longa,
      categoria: p.categoria, atributos: p.atributos,
    })
    const hash = hashDe(texto)
    const [r] = await tx<{ gravou: boolean }[]>`
      INSERT INTO produto_indice (tenant_id, produto_id, texto, texto_sem_acento, texto_hash)
      VALUES (coalesce(${tenantId ?? null}::uuid, tenant_atual()), ${p.id},
              ${texto}, unaccent(lower(${texto})), ${hash})
      ON CONFLICT (tenant_id, produto_id) DO UPDATE
        SET texto = EXCLUDED.texto,
            texto_sem_acento = EXCLUDED.texto_sem_acento,
            texto_hash = EXCLUDED.texto_hash,
            -- Texto novo invalida o vetor antigo; o passo de embedding refaz.
            modelo_embedding = NULL,
            atualizado_em = now()
        -- ⚠️ Só regrava quando mudou: é o que preserva o embedding e evita WAL
        --    à toa numa reindexação de base inteira.
        WHERE produto_indice.texto_hash IS DISTINCT FROM EXCLUDED.texto_hash
      RETURNING true AS gravou`
    if (r?.gravou) indexados += 1
    else inalterados += 1
  }
  return { indexados, inalterados }
}

/** Indexa UM produto — chamado pelas rotas de catálogo logo após cada escrita. */
export async function indexarProduto(tx: Sql, produtoId: string, tenantId?: string): Promise<ResultadoIndexacao> {
  const [produto] = await lerProdutos(tx, [produtoId], tenantId)
  if (!produto) return 'nao_encontrado'
  const r = await gravarIndice(tx, [produto], tenantId)
  return r.indexados === 1 ? 'indexado' : 'inalterado'
}

/**
 * Reindexa o tenant inteiro, em lotes por CURSOR de id — nunca a base de uma
 * vez. Chamado por `POST /v1/catalogo/reindexar` (sessão) e, no integrador,
 * ao fim de uma sincronização de produtos (dono, com `tenantId`).
 */
export async function reindexarTenant(
  tx: Sql,
  opcoes: { tenantId?: string; lote?: number } = {},
): Promise<RelatorioReindexacao> {
  const lote = Math.min(Math.max(opcoes.lote ?? LOTE_PADRAO, 1), LOTE_MAX)
  const tenantId = opcoes.tenantId
  const rel: RelatorioReindexacao = { indexados: 0, inalterados: 0, ausentes: 0 }

  let cursor: string | null = null
  for (;;) {
    const ids: { id: string }[] = await tx<{ id: string }[]>`
      SELECT id FROM produto
       WHERE tenant_id = coalesce(${tenantId ?? null}::uuid, tenant_atual())
         AND ${cursor === null ? tx`true` : tx`id > ${cursor}::uuid`}
       ORDER BY id
       LIMIT ${lote}`
    if (ids.length === 0) break

    const produtos = await lerProdutos(tx, ids.map((i) => i.id), tenantId)
    const r = await gravarIndice(tx, produtos, tenantId)
    rel.indexados += r.indexados
    rel.inalterados += r.inalterados
    rel.ausentes += ids.length - produtos.length

    cursor = ids[ids.length - 1]!.id
    if (ids.length < lote) break
  }
  return rel
}

/**
 * A coluna `embedding` só existe quando o servidor tem pgvector (0088). Lida
 * UMA vez por processo: o schema não muda com a API no ar — muda por migration,
 * que reinicia o processo.
 */
let colunaEmbedding: Promise<boolean> | null = null
export function temColunaEmbedding(tx: Sql): Promise<boolean> {
  if (!colunaEmbedding) {
    colunaEmbedding = tx<{ existe: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM pg_attribute
         WHERE attrelid = 'produto_indice'::regclass
           AND attname = 'embedding' AND NOT attisdropped) AS existe`
      .then((r) => r[0]?.existe === true)
      .catch((erro: unknown) => { colunaEmbedding = null; throw erro })
  }
  return colunaEmbedding
}

/** Só para teste: força nova leitura do schema. */
export function esquecerColunaEmbedding(): void {
  colunaEmbedding = null
}
