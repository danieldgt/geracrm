import {
  avaliarSaude, LIMITES_SAUDE_PADRAO,
  type EntradaSaude, type LimitesSaude, type SaudeDetalhada,
} from '@geracrm/shared'
import type { Sql } from '../../db/index.js'
import type { EstadoDoLlm } from '../atendimento/agente/llm-estado.js'
import { PRAZO_EXECUCAO_MS } from '../atendimento/agente/fila.js'
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
 * ⚠️ Rota pública ⇒ consulta barata e com teto: cada leitura roda com
 *    `statement_timeout`, em pool `max: 1`, e o resultado é CACHEADO por alguns
 *    segundos (single-flight): martelar a URL não multiplica consulta no banco.
 */

/** Agregados lidos do banco. Só números. */
export type LeituraFilas = NonNullable<EntradaSaude['filas']>

/** Quanto tempo uma medição do banco vale antes de medir de novo. */
export const CACHE_MEDICAO_MS = 10_000
/** Teto de cada medição: a rota responde mesmo com o banco pendurado. */
export const TETO_MEDICAO_MS = 2_500
/** Janela de áudio pendente olhada pela saúde (o worker olha 7 dias; aqui só o que importa agora). */
const JANELA_AUDIO_H = 6

export interface ConfiguracaoSaude {
  /** Workers obrigatórios (agente, retornos) agendados — exigem `DATABASE_ADMIN_URL` em `server.ts`. */
  readonly workers: boolean
  /** Provedor de transcrição configurado (GROQ_API_KEY). */
  readonly transcricao: boolean
  /** Nome do provedor de embedding configurado; null = semântica desligada. */
  readonly embeddingModelo: string | null
}

export interface DepsSaude {
  readonly encerrando: () => boolean
  readonly agora: () => Date
  readonly uptimeSeg: () => number
  /** Latência do `SELECT 1` no pool da API, em ms. Rejeita = banco fora. */
  readonly pingBanco: () => Promise<number>
  /** Agregados das filas. Rejeita = sem leitura. */
  readonly lerFilas: () => Promise<LeituraFilas>
  readonly idadeBatimento: (nome: NomeBatimento, agora: Date) => number | null
  readonly estadoDoLlm: () => EstadoDoLlm
  readonly configuracao: ConfiguracaoSaude
  readonly limites?: LimitesSaude
}

const seg = (ms: number) => Math.max(0, Math.floor(ms / 1000))

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

/**
 * Agregados das filas pela conexão de serviço. Uma transação curta com
 * `statement_timeout` local; cada consulta bate num índice parcial
 * (`agente_tarefa_vencidas`, `agente_tarefa_executando`, `agente_retorno_vencidos`)
 * ou na janela recente de `mensagem` (poda de partição por `criado_em`).
 */
export function lerFilasComo(dono: Sql, cfg: ConfiguracaoSaude, agora: () => Date): () => Promise<LeituraFilas> {
  return async () => {
    const t = agora()
    const travadaAntesDe = new Date(t.getTime() - PRAZO_EXECUCAO_MS)
    const audioDesde = new Date(t.getTime() - JANELA_AUDIO_H * 3_600_000)
    const tx0 = dono as unknown as { begin: <R>(fn: (tx: Sql) => Promise<R>) => Promise<R> }
    return tx0.begin(async (tx) => {
      // ⚠️ READ ONLY antes de qualquer consulta (o Postgres exige); SET não aceita
      //    parâmetro, por isso o teto entra por set_config(..., true) = local à transação.
      await tx`SET TRANSACTION READ ONLY`
      await tx`SELECT set_config('statement_timeout', ${String(TETO_MEDICAO_MS)}, true)`
      const [ag] = await tx<{ vencidas: number; mais_antiga: Date | null }[]>`
        SELECT count(*)::int AS vencidas, min(executar_em) AS mais_antiga
          FROM agente_tarefa WHERE estado = 'pendente' AND executar_em <= ${t}`
      const [tv] = await tx<{ travadas: number }[]>`
        SELECT count(*)::int AS travadas
          FROM agente_tarefa WHERE estado = 'executando' AND iniciada_em < ${travadaAntesDe}`
      const [rt] = await tx<{ vencidos: number; mais_antigo: Date | null }[]>`
        SELECT count(*)::int AS vencidos, min(executar_em) AS mais_antigo
          FROM agente_retorno WHERE estado = 'pendente' AND executar_em <= ${t}`

      let transcricao: LeituraFilas['transcricao'] = null
      if (cfg.transcricao) {
        // Mesmo critério de "pendente" do worker (workers/transcricao.ts), sem a espera entre tentativas.
        const [au] = await tx<{ pendentes: number; mais_antiga: Date | null }[]>`
          SELECT count(*)::int AS pendentes, min(criado_em) AS mais_antiga
            FROM mensagem
           WHERE direcao = 'entrante' AND tipo = 'audio' AND criado_em > ${audioDesde}
             AND NOT (conteudo ? 'transcricao')
             AND coalesce((conteudo->>'transcricao_tentativas')::int, 0) < ${MAX_TENTATIVAS_TRANSCRICAO}`
        transcricao = {
          pendentes: au?.pendentes ?? 0,
          maisAntigaHaSeg: au?.mais_antiga ? seg(t.getTime() - new Date(au.mais_antiga).getTime()) : null,
        }
      }

      let embeddings: LeituraFilas['embeddings'] = null
      if (cfg.embeddingModelo) {
        // Mesmo critério de "pendente" de embutir-pendentes.ts: não embutido POR ESTE provedor.
        const [em] = await tx<{ pendentes: number }[]>`
          SELECT ((SELECT count(*) FROM produto_indice WHERE modelo_embedding IS DISTINCT FROM ${cfg.embeddingModelo})
                + (SELECT count(*) FROM conhecimento_trecho WHERE modelo_embedding IS DISTINCT FROM ${cfg.embeddingModelo}))::int
                 AS pendentes`
        embeddings = { pendentes: em?.pendentes ?? 0 }
      }

      return {
        agente: {
          vencidas: ag?.vencidas ?? 0,
          maisAntigaHaSeg: ag?.mais_antiga ? seg(t.getTime() - new Date(ag.mais_antiga).getTime()) : null,
          travadas: tv?.travadas ?? 0,
        },
        retornos: {
          vencidos: rt?.vencidos ?? 0,
          maisAntigoHaSeg: rt?.mais_antigo ? seg(t.getTime() - new Date(rt.mais_antigo).getTime()) : null,
        },
        transcricao,
        embeddings,
      }
    })
  }
}

/** Fotografia → veredito. Nunca rejeita: o que não deu para medir vira `null` e motivo. */
export async function medirSaude(d: DepsSaude): Promise<SaudeDetalhada> {
  const [ping, filas] = await Promise.allSettled([comTeto(d.pingBanco(), TETO_MEDICAO_MS), comTeto(d.lerFilas(), TETO_MEDICAO_MS)])
  const agora = d.agora()
  const llm = d.estadoDoLlm()
  const w = (nome: NomeBatimento, configurado: boolean) => ({ configurado, batimentoHaSeg: d.idadeBatimento(nome, agora) })
  const entrada: EntradaSaude = {
    encerrando: d.encerrando(),
    uptimeSeg: Math.floor(d.uptimeSeg()),
    bancoLatenciaMs: ping.status === 'fulfilled' ? ping.value : null,
    workers: {
      workerAgente: w('workerAgente', d.configuracao.workers),
      transcricao: w('transcricao', d.configuracao.workers && d.configuracao.transcricao),
      embeddings: w('embeddings', d.configuracao.workers && d.configuracao.embeddingModelo !== null),
      retornos: w('retornos', d.configuracao.workers),
    },
    filas: filas.status === 'fulfilled' ? filas.value : null,
    llm: {
      situacao: llm.situacao,
      reservaRestanteSeg: llm.situacao === 'reserva' && llm.reservaAteEm ? seg(llm.reservaAteEm.getTime() - agora.getTime()) : null,
      falhasSeguidas: llm.falhasSeguidas,
      modelosBloqueados: llm.modelosBloqueados.filter((m) => m.ateEm.getTime() > agora.getTime()).length,
    },
  }
  return avaliarSaude(entrada, d.limites ?? LIMITES_SAUDE_PADRAO)
}

