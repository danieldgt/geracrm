import { createHash } from 'node:crypto'
import type { Sql } from '../../db/index.js'

/**
 * CACHE DO VETOR DA PERGUNTA (ADR-026, adendo 2026-10-04).
 *
 * Toda consulta do agente embute a PERGUNTA antes de buscar — e pergunta se
 * repete ("qual o prazo de entrega", "tem frete grátis"). Guardar o vetor por
 * hash do texto normalizado + modelo corta a maioria das chamadas no caminho
 * quente, que é onde latência e limite de requisições doem.
 *
 * Dois níveis: um LRU em memória (por processo, barato) na frente da tabela
 * global `embedding_consulta_cache` (0095, compartilhada entre tenants — o
 * vetor de uma frase não depende de quem perguntou e a tabela não guarda o
 * texto, só o hash).
 *
 * ⚠️ Falha do cache NUNCA falha a busca: ler/gravar engolem erro e a busca
 *    segue chamando o fornecedor. É cache, não fonte.
 */

export interface CacheConsulta {
  ler(chave: string): Promise<number[] | null>
  gravar(chave: string, modelo: string, vetor: readonly number[]): Promise<void>
}

/** Minúsculas, NFC, espaços colapsados, pontuação final fora: "Qual o prazo?" == "qual o prazo". */
export function normalizarConsulta(texto: string): string {
  return texto.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim().replace(/[?!.…\s]+$/u, '')
}

export function chaveDeConsulta(modelo: string, texto: string): string {
  return createHash('sha256').update(`${modelo}\n${normalizarConsulta(texto)}`).digest('hex')
}

/** LRU simples: Map preserva ordem de inserção; reinserir move para o fim. */
export function cacheEmMemoria(max = 500): CacheConsulta & { tamanho(): number } {
  const mapa = new Map<string, number[]>()
  return {
    tamanho: () => mapa.size,
    async ler(chave) {
      const v = mapa.get(chave)
      if (!v) return null
      mapa.delete(chave); mapa.set(chave, v)
      return v
    },
    async gravar(chave, _modelo, vetor) {
      mapa.delete(chave); mapa.set(chave, [...vetor])
      while (mapa.size > max) {
        const primeira = mapa.keys().next().value
        if (primeira === undefined) break
        mapa.delete(primeira)
      }
    },
  }
}

/**
 * Memória na frente do Postgres. A leitura no banco já conta o acerto e renova
 * `usado_em` (um comando só); a gravação é `ON CONFLICT DO NOTHING`.
 */
export function cacheNoPostgres(sql: Sql, opcoes: { memoria?: number } = {}): CacheConsulta {
  const memoria = cacheEmMemoria(opcoes.memoria ?? 500)
  return {
    async ler(chave) {
      const local = await memoria.ler(chave)
      if (local) return local
      try {
        const [l] = await sql<{ embedding: unknown }[]>`
          UPDATE embedding_consulta_cache SET acertos = acertos + 1, usado_em = now()
           WHERE chave = ${chave} RETURNING embedding`
        const v = paraNumeros(l?.embedding)
        if (v) await memoria.gravar(chave, '', v)
        return v
      } catch { return null }
    },
    async gravar(chave, modelo, vetor) {
      await memoria.gravar(chave, modelo, vetor)
      try {
        await sql`
          INSERT INTO embedding_consulta_cache (chave, modelo, embedding, dimensoes)
          VALUES (${chave}, ${modelo}, ${sql.array([...vetor])}::real[], ${vetor.length})
          ON CONFLICT (chave) DO NOTHING`
      } catch { /* cache: nunca derruba a busca */ }
    },
  }
}

function paraNumeros(bruto: unknown): number[] | null {
  if (!Array.isArray(bruto) || bruto.length === 0) return null
  const v = bruto.map(Number)
  return v.every((n) => Number.isFinite(n)) ? v : null
}

/** Poda por idade (sem uso há N dias) e por teto de linhas (as menos usadas saem). Para o worker. */
export async function podarCache(sql: Sql, opcoes: { dias?: number; maxLinhas?: number } = {}): Promise<number> {
  const dias = opcoes.dias ?? 90
  const maxLinhas = opcoes.maxLinhas ?? 200_000
  const porIdade = await sql`DELETE FROM embedding_consulta_cache WHERE usado_em < now() - make_interval(days => ${dias})`
  const porTeto = await sql`
    DELETE FROM embedding_consulta_cache WHERE chave IN (
      SELECT chave FROM embedding_consulta_cache ORDER BY usado_em DESC OFFSET ${maxLinhas})`
  return porIdade.count + porTeto.count
}

let padrao: CacheConsulta | null = null
/** A instância do processo sobre o pool principal — lida na primeira busca, não no import. */
export function cacheConsultaPadrao(sql: Sql): CacheConsulta {
  return (padrao ??= cacheNoPostgres(sql))
}
