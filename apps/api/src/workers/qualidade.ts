import type { Sql } from '../db/index.js'

/**
 * WORKER DE QUALIDADE EM PRODUÇÃO — juiz amostrado — STUB da raia P12 (docs/plano-port-playbook-am.md).
 *
 * Já agendado em `server.ts` pela raia P0 (como DONO, com batimento a cada
 * passada): a raia P12 preenche a passada AQUI, sem tocar no `server.ts`.
 *
 * Contrato: amostra estável (FNV-1a) das decisões; juiz no fim de sessão e a cada 10 turnos, rubrica de 5 critérios, teto mensal de custo (`qualidade_teto_mes_centavos`); grava `agente_avaliacao`. As regras em 100% rodam no turno (`pipeline/regras-qualidade.ts`), não aqui.
 *
 * ⚠️ Enquanto stub: não toca no banco e não faz nada.
 */
export const INTERVALO_QUALIDADE_MS = 60_000

export interface RelatorioQualidade {
  readonly processadas: number
}

/**
 * Dependências injetáveis (adaptadores, relógio, modelo). A raia troca por uma
 * interface com campos OPCIONAIS — `server.ts` passa `{}` e continua valendo.
 */
export type DepsQualidade = Readonly<Record<string, unknown>>

export async function processarQualidade(_dono: Sql, _deps: DepsQualidade = {}, _agora: Date = new Date()): Promise<RelatorioQualidade> {
  return { processadas: 0 }
}
