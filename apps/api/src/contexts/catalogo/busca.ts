import type { AtributosSku, OrigemCatalogo, PerfilPreco, ProdutoResumo, SkuResumo } from '@geracrm/shared'
import type { Sql } from '../../db/index.js'
import { jsonbDe } from '../../db/jsonb.js'
import { fragmentoPrecoDeVenda, precosDeVenda, type PrecoDeVenda } from '../pedido/preco-de-venda.js'
import { chaveDeConsulta, type CacheConsulta } from './cache-consulta.js'
import { temColunaEmbedding } from './indexador.js'
import { ErroEmbedding, type PortaEmbedding } from './porta-embedding.js'

/**
 * BUSCA HÍBRIDA DO CATÁLOGO — tudo dentro do Postgres, sob RLS (ADR-026).
 *
 * Três pernas sobre `produto_indice`, fundidas por Reciprocal Rank Fusion:
 *
 *   lexical   → FTS `pt_sem_acento` (portuguese + unaccent): "camiseta verde G"
 *   trgm      → pg_trgm por token: "camisetta" ainda acha "camiseta"
 *   semantica → pgvector + embedding da consulta, SÓ quando a coluna existe
 *               (servidor com a extensão) e o chamador trouxe o vetor
 *
 * ⚠️ O vetor da consulta vem de FORA da transação. Embutir é rede externa, e
 * rede externa com transação aberta é a causa clássica de pool esgotado. Quem
 * chama faz `embutirConsulta()` antes de abrir `comTenant` e passa o vetor;
 * sem vetor, a busca é lexical e `fontes` diz isso — a degradação é visível.
 *
 * ⚠️ Preço e saldo NÃO estão no índice. Entram no resultado por SKU, resolvidos
 * pelo perfil do cliente com a regra única de `preco-de-venda.ts`.
 */

export type FonteBusca = 'lexical' | 'trgm' | 'semantica'

export interface FiltrosCatalogo {
  categoria?: string
  /** Produto precisa ter SKU ativo com TODOS estes atributos (`@>`). */
  atributos?: AtributosSku
}

export interface OpcoesBusca {
  consulta: string
  perfil: PerfilPreco
  /** Padrão 10, teto 50. Não é paginação: é o "punhado" que a tela/agente mostra. */
  limite?: number
  filtros?: FiltrosCatalogo
  /** Embedding da consulta já calculado fora da transação (ver `embutirConsulta`). */
  vetorConsulta?: readonly number[]
  /**
   * Nome do provedor que gerou o vetor (`porta.nome`). Com ele, a perna semântica só
   * compara com linhas embutidas pelo MESMO provedor — vetor de outro modelo não é
   * comparável e, numa troca de provedor, ficaria no banco até o worker refazer.
   */
  modeloEmbedding?: string
}

export interface SkuDetalhe extends SkuResumo {
  readonly codigoBarras: string | null
  readonly origem: OrigemCatalogo
}

export interface ProdutoDetalhe extends ProdutoResumo {
  readonly ativo: boolean
  readonly imagens: readonly string[]
  readonly atualizadoEm: string
  readonly skus: readonly SkuDetalhe[]
}

export interface ItemBusca extends ProdutoDetalhe {
  /** Pontuação RRF — serve para ordenar e para a tela mostrar "quão perto". */
  readonly score: number
  readonly fontes: readonly FonteBusca[]
}

export interface ResultadoBusca {
  readonly itens: readonly ItemBusca[]
  /** Quais pernas rodaram nesta busca — a tela diz se a semântica estava ligada. */
  readonly fontes: readonly FonteBusca[]
}

const LIMITE_PADRAO = 10
const LIMITE_MAX = 50
/** Constante clássica do RRF: achata a diferença entre 1º e 2º sem zerar a cauda. */
const RRF_K = 60
const MAX_TOKENS_TRGM = 6
const MIN_TAMANHO_TOKEN = 3
/** Teto da leitura em lote de SKUs (mesma ordem de `precosDeVenda`). */
const MAX_SKUS_POR_CONSULTA = 200

function normalizar(texto: string): string {
  return texto.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim()
}

/** Tokens com ≥ 3 letras: "g" de tamanho fica para o FTS, que o acha exato. */
function tokensParaTrgm(consulta: string): string[] {
  const vistos = new Set<string>()
  for (const t of normalizar(consulta).split(/[^\p{L}\p{N}]+/u)) {
    if (t.length >= MIN_TAMANHO_TOKEN) vistos.add(t)
    if (vistos.size >= MAX_TOKENS_TRGM) break
  }
  return [...vistos]
}

/**
 * ⚠️ Caminho QUENTE: a pergunta do cliente espera no máximo isto pelo vetor.
 *    Estourou → busca lexical neste turno, sem erro. O lote do worker usa o
 *    tempo limite longo do adaptador.
 */
export const TIMEOUT_CONSULTA_MS = 2_000

export interface OpcoesEmbutirConsulta {
  readonly cache?: CacheConsulta | undefined
  readonly timeoutMs?: number | undefined
}

export type ResultadoEmbutirConsulta =
  | { vetor: number[]; modelo: string; origem: 'cache' | 'fornecedor' }
  | { vetor: null; motivo: string }

/**
 * Embute a consulta ANTES de abrir a transação. Devolve `null` quando a
 * capacidade está desligada ou o fornecedor falhou — a busca degrada para
 * lexical, e o chamador pode registrar o motivo. Com `cache`, pergunta repetida
 * não vai ao fornecedor.
 */
export async function embutirConsulta(
  porta: PortaEmbedding, consulta: string, opcoes: OpcoesEmbutirConsulta = {},
): Promise<ResultadoEmbutirConsulta> {
  if (!porta.capacidades.buscaSemantica) return { vetor: null, motivo: 'capacidade_desligada' }
  const chave = opcoes.cache ? chaveDeConsulta(porta.nome, consulta) : null
  if (chave && opcoes.cache) {
    const guardado = await opcoes.cache.ler(chave)
    if (guardado) return { vetor: guardado, modelo: porta.nome, origem: 'cache' }
  }
  try {
    const [vetor] = await porta.embutir([consulta], 'consulta', { timeoutMs: opcoes.timeoutMs ?? TIMEOUT_CONSULTA_MS })
    if (!vetor) return { vetor: null, motivo: 'resposta_inesperada' }
    if (chave && opcoes.cache) await opcoes.cache.gravar(chave, porta.nome, vetor)
    return { vetor, modelo: porta.nome, origem: 'fornecedor' }
  } catch (erro) {
    return { vetor: null, motivo: erro instanceof ErroEmbedding ? erro.codigo : 'indisponivel' }
  }
}

/** Condições de filtro comuns às três pernas — aplicadas NO BANCO, com índice. */
function fragmentoFiltros(tx: Sql, filtros: FiltrosCatalogo | undefined) {
  const categoria = filtros?.categoria?.trim()
  const atributos = filtros?.atributos && Object.keys(filtros.atributos).length > 0 ? filtros.atributos : null
  return tx`
    p.ativo
    AND ${categoria ? tx`p.categoria = ${categoria}` : tx`true`}
    AND ${atributos
      ? tx`EXISTS (SELECT 1 FROM sku s
                    WHERE s.tenant_id = p.tenant_id AND s.produto_id = p.id AND s.ativo
                      AND s.atributos @> ${jsonbDe(atributos)}::text::jsonb)`
      : tx`true`}`
}

type Ranqueado = { produto_id: string; posicao: number }

export async function buscarCatalogo(tx: Sql, opcoes: OpcoesBusca): Promise<ResultadoBusca> {
  const consulta = opcoes.consulta.trim()
  const limite = Math.min(Math.max(opcoes.limite ?? LIMITE_PADRAO, 1), LIMITE_MAX)
  if (consulta === '') return { itens: [], fontes: [] }

  const candidatos = Math.min(limite * 3, 60)
  const filtros = fragmentoFiltros(tx, opcoes.filtros)
  const pernas: { fonte: FonteBusca; linhas: Ranqueado[] }[] = []

  const lexical = await tx<Ranqueado[]>`
    SELECT pi.produto_id,
           row_number() OVER (ORDER BY ts_rank_cd(pi.fts, q.q) DESC, pi.produto_id)::int AS posicao
      FROM produto_indice pi
      JOIN produto p ON p.tenant_id = pi.tenant_id AND p.id = pi.produto_id
      CROSS JOIN (SELECT websearch_to_tsquery('pt_sem_acento', ${consulta}) AS q) q
     WHERE pi.tenant_id = tenant_atual()
       AND pi.fts @@ q.q
       AND ${filtros}
     -- ⚠️ ORDER BY posicao: sem ele o LIMIT cortaria linhas arbitrárias, não as melhores.
     ORDER BY posicao
     LIMIT ${candidatos}`
  pernas.push({ fonte: 'lexical', linhas: lexical })

  const tokens = tokensParaTrgm(consulta)
  if (tokens.length > 0) {
    // `<%` (word_similarity) usa o GIN trgm de `texto_sem_acento`; o OR entre
    // tokens é montado aqui, com parâmetros — nunca por concatenação de texto.
    const casaAlgumToken = tokens.reduce(
      (acc, t) => tx`${acc} OR ${t} <% pi.texto_sem_acento`, tx`false`)
    const trgm = await tx<Ranqueado[]>`
      SELECT pi.produto_id,
             row_number() OVER (
               ORDER BY (SELECT avg(word_similarity(t, pi.texto_sem_acento))
                           FROM unnest(${tokens}::text[]) AS t) DESC, pi.produto_id)::int AS posicao
        FROM produto_indice pi
        JOIN produto p ON p.tenant_id = pi.tenant_id AND p.id = pi.produto_id
       WHERE pi.tenant_id = tenant_atual()
         AND (${casaAlgumToken})
         AND ${filtros}
       ORDER BY posicao
       LIMIT ${candidatos}`
    pernas.push({ fonte: 'trgm', linhas: trgm })
  }

  if (opcoes.vetorConsulta && opcoes.vetorConsulta.length > 0 && await temColunaEmbedding(tx)) {
    // Literal de vetor pgvector: "[0.1,0.2,...]" — montado de números, não de texto do cliente.
    const literal = `[${opcoes.vetorConsulta.map((n) => Number(n)).join(',')}]`
    const semantica = await tx<Ranqueado[]>`
      SELECT pi.produto_id,
             row_number() OVER (ORDER BY pi.embedding <=> ${literal}::vector, pi.produto_id)::int AS posicao
        FROM produto_indice pi
        JOIN produto p ON p.tenant_id = pi.tenant_id AND p.id = pi.produto_id
       WHERE pi.tenant_id = tenant_atual()
         AND pi.embedding IS NOT NULL
         AND ${opcoes.modeloEmbedding ? tx`pi.modelo_embedding = ${opcoes.modeloEmbedding}` : tx`true`}
         AND ${filtros}
       ORDER BY posicao
       LIMIT ${candidatos}`
    pernas.push({ fonte: 'semantica', linhas: semantica })
  }

  // RRF: score = Σ 1 / (k + posição) por perna em que o produto aparece.
  const pontuacao = new Map<string, { score: number; fontes: FonteBusca[] }>()
  for (const perna of pernas) {
    for (const linha of perna.linhas) {
      const atual = pontuacao.get(linha.produto_id) ?? { score: 0, fontes: [] }
      atual.score += 1 / (RRF_K + linha.posicao)
      atual.fontes.push(perna.fonte)
      pontuacao.set(linha.produto_id, atual)
    }
  }
  const ordenados = [...pontuacao.entries()]
    .sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]))
    .slice(0, limite)

  const detalhes = await detalharProdutos(tx, ordenados.map(([id]) => id), opcoes.perfil)
  const porId = new Map(detalhes.map((d) => [d.id, d]))
  const itens: ItemBusca[] = []
  for (const [id, { score, fontes }] of ordenados) {
    const d = porId.get(id)
    if (d) itens.push({ ...d, score, fontes })
  }
  return { itens, fontes: pernas.map((p) => p.fonte) }
}

interface LinhaDetalhe {
  id: string; referencia: string; descricao: string; descricao_longa: string | null
  categoria: string | null; imagens: string[]; origem: OrigemCatalogo; ativo: boolean
  atualizado_em: string
  skus: {
    id: string; atributos: AtributosSku; codigo_barras: string | null; origem: OrigemCatalogo
    ativo: boolean; preco_centavos: string | null; saldo: string | null; saldo_em: string | null
  }[]
}

function montarDetalhe(l: LinhaDetalhe): ProdutoDetalhe {
  return {
    id: l.id, referencia: l.referencia, descricao: l.descricao, descricaoLonga: l.descricao_longa,
    categoria: l.categoria, imagem: l.imagens[0] ?? null, imagens: l.imagens, origem: l.origem,
    ativo: l.ativo, atualizadoEm: l.atualizado_em,
    skus: l.skus.map((s) => ({
      id: s.id, atributos: s.atributos, codigoBarras: s.codigo_barras, origem: s.origem, ativo: s.ativo,
      // ⚠️ `::text` na consulta + Number aqui: centavos inteiros, sem passar por float do driver.
      precoCentavos: s.preco_centavos === null ? null : Number(s.preco_centavos),
      saldo: s.saldo === null ? null : Number(s.saldo),
      saldoEm: s.saldo_em,
    })),
  }
}

/**
 * Detalhe de vários produtos de uma vez, com preço por perfil e saldo por SKU.
 * ⚠️ A lista de ids vem do DOMÍNIO (resultado da busca, página da listagem),
 * nunca do cliente; o teto é proteção contra chamador com defeito.
 */
export async function detalharProdutos(
  tx: Sql, ids: readonly string[], perfil: PerfilPreco,
  opcoes: { incluirSkusInativos?: boolean } = {},
): Promise<ProdutoDetalhe[]> {
  const pedidos = [...new Set(ids)]
  if (pedidos.length === 0) return []
  if (pedidos.length > MAX_SKUS_POR_CONSULTA) {
    throw new Error(`detalharProdutos: ${pedidos.length} produtos acima do teto de ${MAX_SKUS_POR_CONSULTA}`)
  }
  const linhas = await tx<LinhaDetalhe[]>`
    SELECT p.id, p.referencia, p.descricao, p.descricao_longa, p.categoria, p.imagens,
           p.origem, p.ativo, p.atualizado_em::text AS atualizado_em,
           coalesce((SELECT json_agg(json_build_object(
                       'id', s.id, 'atributos', s.atributos, 'codigo_barras', s.codigo_barras,
                       'origem', s.origem, 'ativo', s.ativo,
                       -- A MESMA regra de preço do pedido e do agente (preco-de-venda.ts).
                       'preco_centavos', ${fragmentoPrecoDeVenda(tx, 's', perfil)}::text,
                       -- Saldo da última apuração + a data; NÃO ao vivo (ADR-008).
                       'saldo', (SELECT ss.quantidade::text FROM sku_saldo ss
                                  WHERE ss.tenant_id = s.tenant_id AND ss.sku_id = s.id),
                       'saldo_em', (SELECT ss.apurado_em::text FROM sku_saldo ss
                                     WHERE ss.tenant_id = s.tenant_id AND ss.sku_id = s.id)
                     ) ORDER BY s.atributos::text)
                       FROM sku s
                      WHERE s.tenant_id = p.tenant_id AND s.produto_id = p.id
                        AND ${opcoes.incluirSkusInativos ? tx`true` : tx`s.ativo`}),
                    '[]'::json) AS skus
      FROM produto p
     WHERE p.tenant_id = tenant_atual()
       AND p.id = ANY(${pedidos}::uuid[])`
  return linhas.map(montarDetalhe)
}

/** Um produto com SKUs, preços do perfil e saldo. `null` = não existe (ou é de outro tenant). */
export async function detalharProduto(
  tx: Sql, produtoId: string, perfil: PerfilPreco,
  opcoes: { incluirSkusInativos?: boolean } = {},
): Promise<ProdutoDetalhe | null> {
  const [d] = await detalharProdutos(tx, [produtoId], perfil, opcoes)
  return d ?? null
}

/**
 * Preço e estoque de SKUs conhecidos, como situação NOMEADA por SKU — é o que
 * a ferramenta do agente devolve ao modelo e o que a tela usa para dizer
 * "sem preço" em vez de inventar número (PED-08).
 */
export type PrecoEEstoque = PrecoDeVenda & {
  /** null = não controla estoque (ou SKU desconhecido). */
  readonly saldo: number | null
  readonly saldoEm: string | null
}

export async function precoEEstoque(
  tx: Sql, skuIds: readonly string[], perfil: PerfilPreco,
): Promise<ReadonlyMap<string, PrecoEEstoque>> {
  const pedidos = [...new Set(skuIds)]
  if (pedidos.length === 0) return new Map()
  const precos = await precosDeVenda(tx, pedidos, perfil)
  const saldos = await tx<{ sku_id: string; quantidade: string; apurado_em: string }[]>`
    SELECT sku_id, quantidade::text AS quantidade, apurado_em::text AS apurado_em
      FROM sku_saldo
     WHERE tenant_id = tenant_atual() AND sku_id = ANY(${pedidos}::uuid[])`
  const saldoPor = new Map(saldos.map((s) => [s.sku_id, s]))

  const entradas: [string, PrecoEEstoque][] = pedidos.map((id) => {
    const preco = precos.get(id) ?? { situacao: 'sku_desconhecido' as const }
    const s = preco.situacao === 'sku_desconhecido' ? undefined : saldoPor.get(id)
    return [id, { ...preco, saldo: s ? Number(s.quantidade) : null, saldoEm: s?.apurado_em ?? null }]
  })
  return new Map(entradas)
}
