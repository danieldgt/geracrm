import type { Sql } from '../db/index.js'

/**
 * WORKER DE SLA DO HANDOFF — STUB da raia P18 (docs/plano-port-playbook-am.md).
 *
 * Já agendado em `server.ts` pela raia P0 (como DONO, com batimento a cada
 * passada): a raia P18 preenche a passada AQUI, sem tocar no `server.ts`.
 *
 * Contrato: notifica no SLA, libera reatribuição no 2º limiar e manda UMA mensagem de espera fixa (`atendimento.aviso_espera_em`).
 *
 * ⚠️ Enquanto stub: não toca no banco e não faz nada.
 */
export const INTERVALO_SLA_MS = 30_000

export interface RelatorioSla {
  readonly processadas: number
}

/**
 * Dependências injetáveis (adaptadores, relógio, modelo). A raia troca por uma
 * interface com campos OPCIONAIS — `server.ts` passa `{}` e continua valendo.
 */
export type DepsSla = Readonly<Record<string, unknown>>

export async function processarSla(_dono: Sql, _deps: DepsSla = {}, _agora: Date = new Date()): Promise<RelatorioSla> {
  return { processadas: 0 }
}
