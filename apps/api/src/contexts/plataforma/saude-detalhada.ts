import {
  avaliarSaude, LIMITES_SAUDE_PADRAO,
  type EntradaSaude, type LimitesSaude, type SaudeDetalhada,
} from '@geracrm/shared'
import type { Sql } from '../../db/index.js'
import type { EstadoDoLlm } from '../atendimento/agente/llm-estado.js'
import { temColunaEmbedding } from '../catalogo/indexador.js'
import { temColunaEmbeddingConhecimento } from '../atendimento/agente/conhecimento/indexador.js'
// ⚠️ Importa a constante do PRÓPRIO worker de propósito: "áudio pendente" aqui tem
//    de ser exatamente o que o worker ainda vai tentar. Mover a constante para um
//    módulo neutro exigiria editar `workers/transcricao.ts` (fora desta raia).
import { MAX_TENTATIVAS_TRANSCRICAO } from '../../workers/transcricao.js'
import type { NomeBatimento } from './batimento.js'

/**
 * SAÚDE DETALHADA — a MEDIÇÃO (raia P8). O veredito é `avaliarSaude`, pura, em
 * `@geracrm/shared`; aqui só se mede: ping do banco, agregados das filas,
 * batimento dos workers e estado do LLM.
 *
 * ⚠️ AGREGADO DE TODOS OS TENANTS SEM FURAR O RLS DA API. As filas
 *    (`agente_tarefa`, `agente_retorno`, áudio pendente, itens sem embedding)
 *    são lidas pela MESMA conexão de serviço que os workers usam para achar
 *    trabalho (`DATABASE_ADMIN_URL`, o "dono" de `server.ts`) — nunca pelo pool
 *    da API, cujo papel (`geracrm_api`, sem BYPASSRLS) sem tenant vê zero linhas,
 *    e nunca forjando um `geracrm.tenant_id`. E só agregados: `count`, `min` de
 *    data — nenhuma coluna de linha, nenhum `tenant_id` sai do banco. A
 *    alternativa sem conexão de serviço seria uma função SECURITY DEFINER, que
 *    exigiria migration (esta raia não tem).
 * ⚠️ TRÊS LEITURAS INDEPENDENTES: a crítica (fila do agente + retornos) e as
 *    opcionais (áudio, embeddings), cada uma na sua transação, com seu teto e
 *    seu cache. Uma opcional lenta (a de áudio varre a janela recente de
 *    `mensagem`) nunca apaga a leitura da fila do agente. O pool de serviço da
 *    rota tem uma conexão por leitura, para elas não se enfileirarem.
 * ⚠️ Rota pública ⇒ consulta barata e com teto: cada leitura roda com
 *    `statement_timeout`, e o resultado é CACHEADO por alguns segundos
 *    (single-flight): martelar a URL não multiplica consulta no banco.
 */

/** Leitura crítica. Só números. */
export type LeituraFilas = NonNullable<EntradaSaude['filas']>
export type LeituraTranscricao = NonNullable<EntradaSaude['transcricao']>
/** `sem_pgvector`: há chave de embedding, mas o servidor não tem a coluna — a semântica não está ligada. */
export type LeituraEmbeddings =
  | { readonly semantica: 'ligada'; readonly pendentes: number }
  | { readonly semantica: 'sem_pgvector' }

/** Quanto tempo uma medição do banco vale antes de medir de novo. */
export const CACHE_MEDICAO_MS = 10_000
/** Teto de cada medição: a rota responde mesmo com o banco pendurado. */
export const TETO_MEDICAO_MS = 2_500
/** Conexões do pool de serviço da rota: uma por leitura (crítica, áudio, embeddings). */
export const CONEXOES_SAUDE = 3
/** Janela de áudio pendente olhada pela saúde (o worker olha 7 dias; aqui só o que importa agora). */
const JANELA_AUDIO_H = 6

export interface ConfiguracaoSaude {
  /** Workers obrigatórios (agente, retornos) agendados — exigem `DATABASE_ADMIN_URL` em `server.ts`. */
  readonly workers: boolean
  /** Provedor de transcrição configurado (GROQ_API_KEY). */
  readonly transcricao: boolean
  /** Nome do provedor de embedding configurado; null = sem chave. Ligada de fato só com pgvector. */
  readonly embeddingModelo: string | null
}

export interface DepsSaude {
  readonly encerrando: () => boolean
  readonly agora: () => Date
  readonly uptimeSeg: () => number
  /** Latência do `SELECT 1` no pool da API, em ms. Rejeita = banco fora. */
  readonly pingBanco: () => Promise<number>
  /** Fila do agente + retornos. Rejeita = sem leitura. */
  readonly lerFilas: () => Promise<LeituraFilas>
  /** Só chamada com transcrição configurada. Rejeita = sem leitura. */
  readonly lerTranscricao: () => Promise<LeituraTranscricao>
  /** Só chamada com chave de embedding. Rejeita = sem leitura. */
  readonly lerEmbeddings: () => Promise<LeituraEmbeddings>
  readonly idadeBatimento: (nome: NomeBatimento, agora: Date) => number | null
  readonly estadoDoLlm: () => EstadoDoLlm
  readonly configuracao: ConfiguracaoSaude
  readonly limites?: LimitesSaude
}

const seg = (ms: number) => Math.max(0, Math.floor(ms / 1000))
const idade = (agora: Date, d: Date | null | undefined) => (d ? seg(agora.getTime() - new Date(d).getTime()) : null)

/** Rejeita se `p` não resolver em `ms`. O timer não segura o processo vivo. */
export function comTeto<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const teto = new Promise<never>((_, rejeitar) => {
    timer = setTimeout(() => rejeitar(new Error('saude_teto')), ms)
    timer.unref?.()
  })
  return Promise.race([p, teto]).finally(() => clearTimeout(timer))
}

/**
 * Memoriza `fn` por `ttlMs`, com single-flight: chamadas concorrentes dividem a
 * mesma promessa. Falha também é memorizada pelo mesmo tempo — banco fora não
 * vira tempestade de tentativas vinda de uma URL pública.
 */
export function memorizar<T>(fn: () => Promise<T>, ttlMs: number, relogio: () => number = Date.now): () => Promise<T> {
  let ultimo: { em: number; p: Promise<T> } | null = null
  return () => {
    const agora = relogio()
    if (ultimo && agora - ultimo.em < ttlMs) return ultimo.p
    const p = fn()
    p.catch(() => {}) // a rejeição é tratada por quem consome; aqui só evita "unhandled"
    ultimo = { em: agora, p }
    return p
  }
}

/** Ping do banco pelo pool da API (o mesmo do `/pronto`). */
export function pingPeloPool(sql: Sql): () => Promise<number> {
  return async () => {
    const inicio = performance.now()
    await sql`SELECT 1`
    return Math.round(performance.now() - inicio)
  }
}

/** Transação curta, só leitura e com teto no servidor. */
function lendo<T>(dono: Sql, fn: (tx: Sql) => Promise<T>): Promise<T> {
  const pool = dono as unknown as { begin: <R>(fn: (tx: Sql) => Promise<R>) => Promise<R> }
  return pool.begin(async (tx) => {
    // ⚠️ READ ONLY antes de qualquer consulta (o Postgres exige); SET não aceita
    //    parâmetro, por isso o teto entra por set_config(..., true) = local à transação.
    await tx`SET TRANSACTION READ ONLY`
    await tx`SELECT set_config('statement_timeout', ${String(TETO_MEDICAO_MS)}, true)`
    return fn(tx)
  })
}

/**
 * Restringe a leitura a alguns tenants — SÓ para teste contra o banco
 * compartilhado da suíte (mesmo recurso de `somenteTenant` do worker de
 * transcrição). A rota nunca passa isto.
 */
export interface OpcoesLeitura {
  readonly somenteTenants?: readonly string[] | undefined
}

/**
 * Leitura CRÍTICA: fila do agente e retornos, nos índices parciais
 * (`agente_tarefa_vencidas`, `agente_tarefa_executando`, `agente_retorno_vencidos`).
 */
export function lerFilasComo(dono: Sql, agora: () => Date, o: OpcoesLeitura = {}): () => Promise<LeituraFilas> {
  return () => lendo(dono, async (tx) => {
    const t = agora()
    const recorte = o.somenteTenants ? tx`AND tenant_id IN ${tx(o.somenteTenants as string[])}` : tx``
    const [ag] = await tx<{ vencidas: number; mais_antiga: Date | null }[]>`
      SELECT count(*)::int AS vencidas, min(executar_em) AS mais_antiga
        FROM agente_tarefa WHERE estado = 'pendente' AND executar_em <= ${t} ${recorte}`
    const [ex] = await tx<{ executando: number; mais_antiga: Date | null }[]>`
      SELECT count(*)::int AS executando, min(iniciada_em) AS mais_antiga
        FROM agente_tarefa WHERE estado = 'executando' ${recorte}`
    const [rt] = await tx<{ vencidos: number; mais_antigo: Date | null }[]>`
      SELECT count(*)::int AS vencidos, min(executar_em) AS mais_antigo
        FROM agente_retorno WHERE estado = 'pendente' AND executar_em <= ${t} ${recorte}`
    return {
      agente: {
        vencidas: ag?.vencidas ?? 0,
        maisAntigaHaSeg: idade(t, ag?.mais_antiga),
        executando: ex?.executando ?? 0,
        executandoMaisAntigaHaSeg: idade(t, ex?.mais_antiga),
      },
      retornos: { vencidos: rt?.vencidos ?? 0, maisAntigoHaSeg: idade(t, rt?.mais_antigo) },
    }
  })
}

/** Áudio entrante ainda por transcrever — mesmo critério do worker, sem a espera entre tentativas. */
export function lerTranscricaoComo(dono: Sql, agora: () => Date, o: OpcoesLeitura = {}): () => Promise<LeituraTranscricao> {
  return () => lendo(dono, async (tx) => {
    const t = agora()
    const desde = new Date(t.getTime() - JANELA_AUDIO_H * 3_600_000)
    const recorte = o.somenteTenants ? tx`AND tenant_id IN ${tx(o.somenteTenants as string[])}` : tx``
    const [au] = await tx<{ pendentes: number; mais_antiga: Date | null }[]>`
      SELECT count(*)::int AS pendentes, min(criado_em) AS mais_antiga
        FROM mensagem
       WHERE direcao = 'entrante' AND tipo = 'audio' AND criado_em > ${desde} ${recorte}
         AND NOT (conteudo ? 'transcricao')
         AND coalesce((conteudo->>'transcricao_tentativas')::int, 0) < ${MAX_TENTATIVAS_TRANSCRICAO}`
    return { pendentes: au?.pendentes ?? 0, maisAntigaHaSeg: idade(t, au?.mais_antiga) }
  })
}

/**
 * Itens sem embedding DESTE provedor — mesmo critério de `embutir-pendentes.ts`.
 * Sem pgvector a semântica não está ligada (o worker não tem onde gravar): não
 * conta nada e devolve `sem_pgvector`.
 */
export function lerEmbeddingsComo(dono: Sql, modelo: string, o: OpcoesLeitura = {}): () => Promise<LeituraEmbeddings> {
  return () => lendo(dono, async (tx) => {
    const [a, b] = await Promise.all([temColunaEmbedding(tx), temColunaEmbeddingConhecimento(tx)])
    if (!a || !b) return { semantica: 'sem_pgvector' as const }
    const recorte = o.somenteTenants ? tx`AND tenant_id IN ${tx(o.somenteTenants as string[])}` : tx``
    const [em] = await tx<{ pendentes: number }[]>`
      SELECT ((SELECT count(*) FROM produto_indice WHERE modelo_embedding IS DISTINCT FROM ${modelo} ${recorte})
            + (SELECT count(*) FROM conhecimento_trecho WHERE modelo_embedding IS DISTINCT FROM ${modelo} ${recorte}))::int
             AS pendentes`
    return { semantica: 'ligada' as const, pendentes: em?.pendentes ?? 0 }
  })
}

const valor = <T>(r: PromiseSettledResult<T> | null): T | null => (r?.status === 'fulfilled' ? r.value : null)

/** Fotografia → veredito. Nunca rejeita: o que não deu para medir vira `null` e motivo. */
export async function medirSaude(d: DepsSaude): Promise<SaudeDetalhada> {
  const cfg = d.configuracao
  const teto = <T>(p: () => Promise<T>) => comTeto(p(), TETO_MEDICAO_MS)
  const [ping, filas, audio, emb] = await Promise.allSettled([
    teto(d.pingBanco),
    teto(d.lerFilas),
    cfg.workers && cfg.transcricao ? teto(d.lerTranscricao) : Promise.resolve(null),
    cfg.workers && cfg.embeddingModelo !== null ? teto(d.lerEmbeddings) : Promise.resolve(null),
  ])
  const agora = d.agora()
  const llm = d.estadoDoLlm()
  const leituraEmb = valor(emb)
  // Embeddings só contam como configurados com a semântica de fato ligada: chave
  // E pgvector. Sem leitura (teto, banco), vale a chave — e o motivo é "sem leitura".
  const embeddingsLigado = cfg.workers && cfg.embeddingModelo !== null && leituraEmb?.semantica !== 'sem_pgvector'
  const w = (nome: NomeBatimento, configurado: boolean) => ({ configurado, batimentoHaSeg: d.idadeBatimento(nome, agora) })
  const entrada: EntradaSaude = {
    encerrando: d.encerrando(),
    uptimeSeg: Math.floor(d.uptimeSeg()),
    bancoLatenciaMs: valor(ping),
    workers: {
      workerAgente: w('workerAgente', cfg.workers),
      transcricao: w('transcricao', cfg.workers && cfg.transcricao),
      embeddings: w('embeddings', embeddingsLigado),
      retornos: w('retornos', cfg.workers),
    },
    filas: valor(filas),
    transcricao: valor(audio),
    embeddings: leituraEmb?.semantica === 'ligada' ? { pendentes: leituraEmb.pendentes } : null,
    llm: {
      situacao: llm.situacao,
      reservaRestanteSeg: llm.situacao === 'reserva' && llm.reservaAteEm ? seg(llm.reservaAteEm.getTime() - agora.getTime()) : null,
      falhasSeguidas: llm.falhasSeguidas,
      modelosBloqueados: llm.modelosBloqueados.filter((m) => m.ateEm.getTime() > agora.getTime()).length,
    },
  }
  return avaliarSaude(entrada, d.limites ?? LIMITES_SAUDE_PADRAO)
}
