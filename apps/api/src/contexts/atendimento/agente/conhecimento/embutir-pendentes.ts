import type { Sql } from '../../../../db/index.js'
import { temColunaEmbedding } from '../../../catalogo/indexador.js'
import { podarCache } from '../../../catalogo/cache-consulta.js'
import { ErroEmbedding, faltaParaEmbedding, type CodigoErroEmbedding, type PortaEmbedding } from '../../../catalogo/porta-embedding.js'
import { temColunaEmbeddingConhecimento } from './indexador.js'

/**
 * A PERNA SEMÂNTICA COMO CAPACIDADE — e o passo que a mantém em dia (ADR-026, ADR-008).
 *
 * `produto_indice` e `conhecimento_trecho` nascem sem vetor: o indexador grava o
 * texto e zera `modelo_embedding`. Este módulo é o passo seguinte — pega o que
 * está pendente (`modelo_embedding` diferente do provedor atual), embute FORA de
 * qualquer transação (rede externa) e grava o vetor com guarda de `texto_hash`:
 * se o texto mudou enquanto a rede respondia, o vetor velho NÃO entra.
 *
 * Serve a dois chamadores com o mesmo código:
 *   - o worker em `server.ts`, como DONO (todos os tenants), por intervalo;
 *   - o botão "Embutir agora" da tela, como TENANT (sob RLS), pela rota.
 *
 * `capacidadesDeBusca` é o que a tela mostra: se há pgvector, se há chave, o
 * que falta embutir. Degradação visível, nunca silenciosa.
 */

export type EstadoSemantica = 'ligada' | 'sem_pgvector' | 'sem_chave'

export interface CapacidadesDeBusca {
  readonly pgvector: boolean
  /** `falta` nomeia a(s) variável(is) de ambiente que destravam a semântica — para quem resolve. */
  readonly embedding: { readonly configurado: boolean; readonly provedor: string | null; readonly falta: string | null }
  readonly semantica: EstadoSemantica
  readonly pendentes: { readonly produtos: number; readonly trechos: number }
  readonly embutidos: { readonly produtos: number; readonly trechos: number }
}

export interface RelatorioEmbutir {
  readonly produtos: number
  readonly trechos: number
  readonly restantes: { readonly produtos: number; readonly trechos: number }
  /** Por que parou antes de zerar os pendentes — `null` quando acabou o trabalho ou o teto de lotes. */
  readonly parou: EstadoSemantica | CodigoErroEmbedding | null
}

/** Quem abre e fecha a transação: `(fn) => req.comTenant(fn)` na rota, `(fn) => dono.begin(fn)` no worker. */
export type Executar = <T>(fn: (tx: Sql) => Promise<T>) => Promise<T>

/** ⚠️ Pequeno de propósito: a faixa gratuita da Voyage é apertada (RPM/TPM); 16 trechos ≈ 8 k tokens. */
export const LOTE_PADRAO = 16
export const LOTE_MAX = 64
const MAX_LOTES_PADRAO = 3

type Tabela = 'produto_indice' | 'conhecimento_trecho'

async function temPgvector(tx: Sql): Promise<boolean> {
  const [a, b] = await Promise.all([temColunaEmbedding(tx), temColunaEmbeddingConhecimento(tx)])
  return a && b
}

function estadoSemantica(pgvector: boolean, porta: PortaEmbedding): EstadoSemantica {
  if (!pgvector) return 'sem_pgvector'
  if (!porta.capacidades.buscaSemantica) return 'sem_chave'
  return 'ligada'
}

async function contar(tx: Sql, tabela: Tabela, porta: PortaEmbedding, pgvector: boolean)
  : Promise<{ pendentes: number; embutidos: number }> {
  // Com provedor: pendente é o que não foi embutido POR ELE (troca de modelo refaz tudo).
  // Sem provedor: pendente é o que nunca foi embutido — `IS DISTINCT FROM NULL` contaria zero.
  const pendente = porta.capacidades.buscaSemantica
    ? tx`modelo_embedding IS DISTINCT FROM ${porta.nome}`
    : tx`modelo_embedding IS NULL`
  const embutido = pgvector ? tx`count(*) FILTER (WHERE embedding IS NOT NULL)::int` : tx`0::int`
  const [r] = tabela === 'produto_indice'
    ? await tx<{ pendentes: number; embutidos: number }[]>`
        SELECT count(*) FILTER (WHERE ${pendente})::int AS pendentes, ${embutido} AS embutidos FROM produto_indice`
    : await tx<{ pendentes: number; embutidos: number }[]>`
        SELECT count(*) FILTER (WHERE ${pendente})::int AS pendentes, ${embutido} AS embutidos FROM conhecimento_trecho`
  return { pendentes: r?.pendentes ?? 0, embutidos: r?.embutidos ?? 0 }
}

export async function capacidadesDeBusca(tx: Sql, porta: PortaEmbedding, env: NodeJS.ProcessEnv = process.env): Promise<CapacidadesDeBusca> {
  const pgvector = await temPgvector(tx)
  const [p, t] = await Promise.all([contar(tx, 'produto_indice', porta, pgvector), contar(tx, 'conhecimento_trecho', porta, pgvector)])
  const configurado = porta.capacidades.buscaSemantica
  return {
    pgvector,
    embedding: { configurado, provedor: configurado ? porta.nome : null, falta: configurado ? null : faltaParaEmbedding(env) },
    semantica: estadoSemantica(pgvector, porta),
    pendentes: { produtos: p.pendentes, trechos: t.pendentes },
    embutidos: { produtos: p.embutidos, trechos: t.embutidos },
  }
}

interface Pendente { tenant_id: string; id: string; texto: string; texto_hash: string }

async function lerLote(tx: Sql, tabela: Tabela, nome: string, lote: number): Promise<Pendente[]> {
  if (tabela === 'produto_indice') {
    return tx<Pendente[]>`
      SELECT tenant_id, produto_id AS id, texto, texto_hash FROM produto_indice
       WHERE modelo_embedding IS DISTINCT FROM ${nome}
       ORDER BY atualizado_em, produto_id LIMIT ${lote}`
  }
  return tx<Pendente[]>`
    SELECT tenant_id, id, texto, texto_hash FROM conhecimento_trecho
     WHERE modelo_embedding IS DISTINCT FROM ${nome}
     ORDER BY criado_em, id LIMIT ${lote}`
}

/** Grava os vetores — só onde o texto ainda é o mesmo que foi embutido. Devolve quantos entraram. */
async function gravarLote(tx: Sql, tabela: Tabela, nome: string, linhas: readonly Pendente[], vetores: readonly number[][]): Promise<number> {
  let gravados = 0
  for (let i = 0; i < linhas.length; i++) {
    const l = linhas[i]!
    const literal = `[${vetores[i]!.map((n) => Number(n)).join(',')}]`
    const r = tabela === 'produto_indice'
      ? await tx`UPDATE produto_indice SET embedding = ${literal}::vector, modelo_embedding = ${nome}
                  WHERE tenant_id = ${l.tenant_id} AND produto_id = ${l.id} AND texto_hash = ${l.texto_hash}`
      : await tx`UPDATE conhecimento_trecho SET embedding = ${literal}::vector, modelo_embedding = ${nome}
                  WHERE tenant_id = ${l.tenant_id} AND id = ${l.id} AND texto_hash = ${l.texto_hash}`
    gravados += r.count
  }
  return gravados
}

/**
 * Embute o que está pendente, tabela a tabela, em lotes. Para no teto de lotes,
 * quando acaba o trabalho, ou na primeira falha do fornecedor (quem chama decide
 * se tenta de novo: o worker no próximo ciclo, a rota devolve o código).
 */
export async function embutirPendentes(
  executar: Executar, porta: PortaEmbedding,
  opcoes: { lote?: number; maxLotes?: number } = {},
): Promise<RelatorioEmbutir> {
  const lote = Math.min(Math.max(opcoes.lote ?? LOTE_PADRAO, 1), LOTE_MAX)
  const maxLotes = Math.max(opcoes.maxLotes ?? MAX_LOTES_PADRAO, 1)
  const feitos = { produto_indice: 0, conhecimento_trecho: 0 }
  let parou: RelatorioEmbutir['parou'] = null

  const pgvector = await executar((tx) => temPgvector(tx))
  const estado = estadoSemantica(pgvector, porta)
  if (estado !== 'ligada') parou = estado
  else {
    const nome = porta.nome
    let lotesUsados = 0
    // Conhecimento primeiro: é menor e é o que responde política/FAQ; catálogo em seguida.
    tabelas: for (const tabela of ['conhecimento_trecho', 'produto_indice'] as const) {
      while (lotesUsados < maxLotes) {
        const linhas = await executar((tx) => lerLote(tx, tabela, nome, lote))
        if (linhas.length === 0) break
        lotesUsados += 1
        let vetores: number[][]
        try {
          // ⚠️ Rede externa SEM transação aberta.
          vetores = await porta.embutir(linhas.map((l) => l.texto), 'documento')
        } catch (erro) {
          parou = erro instanceof ErroEmbedding ? erro.codigo : 'indisponivel'
          break tabelas
        }
        feitos[tabela] += await executar((tx) => gravarLote(tx, tabela, nome, linhas, vetores))
        if (linhas.length < lote) break
      }
    }
  }

  const restantes = await executar(async (tx) => {
    const [p, t] = await Promise.all([contar(tx, 'produto_indice', porta, pgvector), contar(tx, 'conhecimento_trecho', porta, pgvector)])
    return { produtos: p.pendentes, trechos: t.pendentes }
  })
  return { produtos: feitos.produto_indice, trechos: feitos.conhecimento_trecho, restantes, parou }
}

/**
 * Uma passada do WORKER, como dono: advisory lock para várias instâncias não
 * embutirem (e pagarem) em dobro. `dono` precisa ser pool `max: 1` — lock e
 * unlock têm de acontecer na mesma conexão.
 */
export async function passadaDeEmbedding(
  dono: Sql, porta: PortaEmbedding, opcoes: { lote?: number; maxLotes?: number } = {},
): Promise<RelatorioEmbutir | 'ocupado' | 'desligado'> {
  if (!porta.capacidades.buscaSemantica) return 'desligado'
  const [l] = await dono<{ ok: boolean }[]>`SELECT pg_try_advisory_lock(hashtext('embutir_pendentes')) AS ok`
  if (!l?.ok) return 'ocupado'
  try {
    const executar: Executar = <T>(fn: (tx: Sql) => Promise<T>) =>
      dono.begin((tx) => fn(tx as unknown as Sql)) as unknown as Promise<T>
    const r = await embutirPendentes(executar, porta, opcoes)
    // Poda do cache de consultas na mesma passada: barato, e ninguém mais faz.
    await podarCache(dono).catch(() => 0)
    return r
  } finally {
    await dono`SELECT pg_advisory_unlock(hashtext('embutir_pendentes'))`
  }
}
