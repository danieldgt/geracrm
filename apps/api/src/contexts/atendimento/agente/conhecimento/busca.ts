import type { Sql } from '../../../../db/index.js'
import { temColunaEmbeddingConhecimento } from './indexador.js'
import type {
  FonteConhecimento, OpcoesBuscaConhecimento, ResultadoBuscaConhecimento, TipoDocumento, TrechoEncontrado,
} from './porta.js'

/**
 * BUSCA HÍBRIDA DE CONHECIMENTO — tudo dentro do Postgres, sob RLS (ADR-026).
 *
 * Mesmo desenho de `catalogo/busca.ts`, sobre `conhecimento_trecho`:
 *
 *   lexical   → FTS `pt_sem_acento`: "prazo de entrega" acha o parágrafo certo
 *   trgm      → pg_trgm por token: "entrgea" ainda acha "entrega"
 *   semantica → pgvector + embedding da pergunta, SÓ quando a coluna existe e
 *               o chamador trouxe o vetor (calculado FORA da transação)
 *
 * Fusão por Reciprocal Rank Fusion. Só documentos PUBLICADOS; com canal, os
 * do canal e os globais (`canal_id` NULL).
 */

const LIMITE_PADRAO = 3
const LIMITE_MAX = 10
const RRF_K = 60
const MAX_TOKENS_TRGM = 6
const MIN_TAMANHO_TOKEN = 3
const LIMIAR_TRGM = '0.45'

function normalizar(texto: string): string {
  return texto.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim()
}

/** Tokens com ≥ 3 letras — "de", "o", "em" ficam para o FTS, que os descarta como stopwords. */
function tokensParaTrgm(pergunta: string): string[] {
  const vistos = new Set<string>()
  for (const t of normalizar(pergunta).split(/[^\p{L}\p{N}]+/u)) {
    if (t.length >= MIN_TAMANHO_TOKEN) vistos.add(t)
    if (vistos.size >= MAX_TOKENS_TRGM) break
  }
  return [...vistos]
}

type Ranqueado = { id: string; posicao: number }

export async function buscarConhecimento(tx: Sql, opcoes: OpcoesBuscaConhecimento): Promise<ResultadoBuscaConhecimento> {
  const pergunta = opcoes.pergunta.trim()
  const limite = Math.min(Math.max(opcoes.limite ?? LIMITE_PADRAO, 1), LIMITE_MAX)
  if (pergunta === '') return { trechos: [], fontes: [] }

  const candidatos = Math.min(limite * 3, 30)
  // Documento publicado e visível para o canal — aplicado em TODAS as pernas.
  const visivel = tx`
    d.publicado
    AND ${opcoes.canalId ? tx`(d.canal_id IS NULL OR d.canal_id = ${opcoes.canalId})` : tx`true`}`
  const pernas: { fonte: FonteConhecimento; linhas: Ranqueado[] }[] = []

  const lexical = await tx<Ranqueado[]>`
    SELECT ct.id,
           row_number() OVER (ORDER BY ts_rank_cd(ct.fts, q.q) DESC, ct.id)::int AS posicao
      FROM conhecimento_trecho ct
      JOIN conhecimento_documento d ON d.tenant_id = ct.tenant_id AND d.id = ct.documento_id
      CROSS JOIN (SELECT websearch_to_tsquery('pt_sem_acento', ${pergunta}) AS q) q
     WHERE ct.tenant_id = tenant_atual()
       AND ct.fts @@ q.q
       AND ${visivel}
     ORDER BY posicao
     LIMIT ${candidatos}`
  pernas.push({ fonte: 'lexical', linhas: lexical })

  const tokens = tokensParaTrgm(pergunta)
  if (tokens.length > 0) {
    // ⚠️ O limiar padrão do pg_trgm (0.6) deixa passar "camisetta" mas barra
    //    "entrgea" (4 trigramas em 8 = 0.5). Texto de política é frase longa,
    //    e a pergunta do cliente vem com erro de digitação de WhatsApp; o RRF
    //    ordena, então ser mais permissivo aqui custa pouco. SET LOCAL morre
    //    com a transação — não vaza para a próxima conexão do pool.
    //    (set_config com is_local = true; SET não aceita parâmetro ligado.)
    await tx`SELECT set_config('pg_trgm.word_similarity_threshold', ${LIMIAR_TRGM}, true)`
    const casaAlgumToken = tokens.reduce(
      (acc, t) => tx`${acc} OR ${t} <% ct.texto_sem_acento`, tx`false`)
    const trgm = await tx<Ranqueado[]>`
      SELECT ct.id,
             row_number() OVER (
               ORDER BY (SELECT avg(word_similarity(t, ct.texto_sem_acento))
                           FROM unnest(${tokens}::text[]) AS t) DESC, ct.id)::int AS posicao
        FROM conhecimento_trecho ct
        JOIN conhecimento_documento d ON d.tenant_id = ct.tenant_id AND d.id = ct.documento_id
       WHERE ct.tenant_id = tenant_atual()
         AND (${casaAlgumToken})
         AND ${visivel}
       ORDER BY posicao
       LIMIT ${candidatos}`
    pernas.push({ fonte: 'trgm', linhas: trgm })
  }

  if (opcoes.vetorConsulta && opcoes.vetorConsulta.length > 0 && await temColunaEmbeddingConhecimento(tx)) {
    const literal = `[${opcoes.vetorConsulta.map((n) => Number(n)).join(',')}]`
    const semantica = await tx<Ranqueado[]>`
      SELECT ct.id,
             row_number() OVER (ORDER BY ct.embedding <=> ${literal}::vector, ct.id)::int AS posicao
        FROM conhecimento_trecho ct
        JOIN conhecimento_documento d ON d.tenant_id = ct.tenant_id AND d.id = ct.documento_id
       WHERE ct.tenant_id = tenant_atual()
         AND ct.embedding IS NOT NULL
         AND ${visivel}
       ORDER BY posicao
       LIMIT ${candidatos}`
    pernas.push({ fonte: 'semantica', linhas: semantica })
  }

  const pontuacao = new Map<string, { score: number; fontes: FonteConhecimento[] }>()
  for (const perna of pernas) {
    for (const linha of perna.linhas) {
      const atual = pontuacao.get(linha.id) ?? { score: 0, fontes: [] }
      atual.score += 1 / (RRF_K + linha.posicao)
      atual.fontes.push(perna.fonte)
      pontuacao.set(linha.id, atual)
    }
  }
  const ordenados = [...pontuacao.entries()]
    .sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]))
    .slice(0, limite)
  if (ordenados.length === 0) return { trechos: [], fontes: pernas.map((p) => p.fonte) }

  const detalhes = await tx<{ id: string; texto: string; documento_id: string; titulo: string; tipo: TipoDocumento; versao: number }[]>`
    SELECT ct.id, ct.texto, ct.documento_id, d.titulo, d.tipo, d.versao
      FROM conhecimento_trecho ct
      JOIN conhecimento_documento d ON d.tenant_id = ct.tenant_id AND d.id = ct.documento_id
     WHERE ct.tenant_id = tenant_atual()
       AND ct.id = ANY(${ordenados.map(([id]) => id)}::uuid[])`
  const porId = new Map(detalhes.map((d) => [d.id, d]))
  const trechos: TrechoEncontrado[] = []
  for (const [id, { score, fontes }] of ordenados) {
    const d = porId.get(id)
    if (d) trechos.push({ texto: d.texto, documentoId: d.documento_id, titulo: d.titulo, tipo: d.tipo, versao: d.versao, score, fontes })
  }
  return { trechos, fontes: pernas.map((p) => p.fonte) }
}
