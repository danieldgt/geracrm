import type { Sql } from '../db/index.js'

/**
 * WORKER DE PÓS-INGESTÃO DO WEBHOOK — STUB da raia P11 (docs/plano-port-playbook-am.md).
 *
 * Já agendado em `server.ts` pela raia P0 (como DONO, com batimento a cada
 * passada): a raia P11 preenche a passada AQUI, sem tocar no `server.ts`.
 *
 * Contrato: drena `tarefa_pos_ingestao`: mensagem de ausência e download de mídia da Meta saem do request do webhook (que só grava + agenda + 200).
 *
 * ⚠️ Enquanto stub: não toca no banco e não faz nada.
 */
export const INTERVALO_POS_INGESTAO_MS = 2_000

export interface RelatorioPosIngestao {
  readonly processadas: number
}

/**
 * Dependências injetáveis (adaptadores, relógio, modelo). A raia troca por uma
 * interface com campos OPCIONAIS — `server.ts` passa `{}` e continua valendo.
 */
export type DepsPosIngestao = Readonly<Record<string, unknown>>

export async function processarPosIngestao(_dono: Sql, _deps: DepsPosIngestao = {}, _agora: Date = new Date()): Promise<RelatorioPosIngestao> {
  return { processadas: 0 }
}
