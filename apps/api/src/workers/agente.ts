import type { Sql } from '../db/index.js'
import {
  pegarProximaTarefa, concluirTarefa, falharTarefa, reagendarTarefa, recuperarTravadas, type Tarefa,
} from '../contexts/atendimento/agente/fila.js'
import { conduzirTurnoVendedor, type DepsTurno, type ResultadoTurnoVendedor } from '../contexts/atendimento/agente/vendedor.js'
import { indicarDigitacaoDaTarefa } from '../contexts/atendimento/agente/digitacao.js'

/**
 * O WORKER DO AGENTE (ADR-024) — drena `agente_tarefa`, uma tarefa por vez por
 * conversa. Roda como DONO (sem tenant de sessão) para PEGAR a tarefa; o turno
 * em si roda sob o tenant da tarefa (`comTenantServico`), como todo serviço.
 *
 * ⚠️ Varredura a cada segundo: com debounce de 3 s, o custo de latência é de
 * no máximo 1 s, e a consulta bate num índice parcial (só pendentes). Acordar
 * por NOTIFY fica para quando a medição pedir.
 */
export const INTERVALO_WORKER_MS = 1_000
/** Quantas tarefas uma passada processa, no máximo, antes de devolver o laço. */
const LOTE = 8
/**
 * ⚠️ Turnos de conversas DIFERENTES correm em paralelo (até este teto). Serial
 * é por conversa (índice + SKIP LOCKED), não global: com 10 conversas e turnos
 * de 8 s, a décima esperaria 80 s num laço sequencial.
 */
export const CONCORRENCIA = 4

export interface RelatorioPassada {
  processadas: number
  respondidas: number
  handoffs: number
  falhas: number
  recuperadas: number
}

export async function processarTarefasDoAgente(
  dono: Sql, deps: DepsTurno, agora: Date = new Date(),
): Promise<RelatorioPassada> {
  const r: RelatorioPassada = { processadas: 0, respondidas: 0, handoffs: 0, falhas: 0, recuperadas: 0 }
  r.recuperadas = await recuperarTravadas(dono, agora)
  const contar = (desfecho: ResultadoTurnoVendedor['desfecho'] | 'erro') => {
    if (desfecho === 'respondeu' || desfecho === 'sugeriu') r.respondidas += 1
    else if (desfecho === 'handoff') r.handoffs += 1
    else if (desfecho === 'falha' || desfecho === 'erro') r.falhas += 1
  }
  const trabalhadores = Array.from({ length: CONCORRENCIA }, async () => {
    while (r.processadas < LOTE) {
      const tarefa = await pegarProximaTarefa(dono, agora)
      if (!tarefa) return
      r.processadas += 1
      // "Digitando…" (R5): best-effort, nunca segura o turno — só onde o canal
      // declara a capacidade e o agente está em modo autônomo.
      void indicarDigitacaoDaTarefa(tarefa)
      contar(await executarUma(dono, tarefa, deps, agora))
    }
  })
  await Promise.all(trabalhadores)
  return r
}

async function executarUma(dono: Sql, tarefa: Tarefa, deps: DepsTurno, agora: Date): Promise<ResultadoTurnoVendedor['desfecho'] | 'erro'> {
  let resultado: ResultadoTurnoVendedor
  try {
    resultado = await conduzirTurnoVendedor(tarefa, { ...deps, agora: deps.agora ?? new Date() })
  } catch (e) {
    // ⚠️ Erro NOSSO (bug, banco): volta para a fila com backoff, até o teto.
    //    O cliente não fica sem resposta para sempre: no teto, a tarefa falha
    //    com o erro gravado — e a tela de decisões mostra.
    await falharTarefa(dono, tarefa, e instanceof Error ? e.message : String(e), agora)
    return 'erro'
  }
  // ⚠️ O pós-turno também não pode derrubar a passada: uma falha aqui deixaria
  //    a tarefa em `executando` até a recuperação e pararia as outras conversas.
  try {
    if (resultado.desfecho === 'superada') await reagendarTarefa(dono, tarefa, agora)
    else await concluirTarefa(dono, tarefa, agora)
  } catch (e) {
    await falharTarefa(dono, tarefa, e instanceof Error ? e.message : String(e), agora).catch(() => undefined)
  }
  return resultado.desfecho
}
