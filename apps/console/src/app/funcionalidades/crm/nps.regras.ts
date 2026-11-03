/**
 * Regras PURAS do painel de NPS — sem Angular, testáveis em node.
 *
 * Origem `agente` (G3): a nota que o agente registra no pós-venda não avalia um
 * vendedor — aparece num bloco PRÓPRIO, distinguido, e nunca soma no ranking por
 * atendente. API antiga (sem o bloco) = agente zerado.
 */

export interface BlocoAgenteNps {
  readonly total: number
  readonly promotores: number
  readonly neutros: number
  readonly detratores: number
  readonly score: number | null
}

export const AGENTE_VAZIO: BlocoAgenteNps = { total: 0, promotores: 0, neutros: 0, detratores: 0, score: null }

/** Lê o bloco do agente da resposta, tolerando API sem ele. */
export function blocoDoAgente(r: { readonly agente?: BlocoAgenteNps | null }): BlocoAgenteNps {
  return r.agente ?? AGENTE_VAZIO
}

/** Há o que mostrar no período? Vendedor avaliado OU nota do agente. */
export function temNpsNoPeriodo(r: { readonly porAtendente: readonly unknown[]; readonly agente?: BlocoAgenteNps | null }): boolean {
  return r.porAtendente.length > 0 || blocoDoAgente(r).total > 0
}

/** "+40" · "0" · "−20" · "—" (sem respostas). */
export function textoScore(score: number | null): string {
  if (score === null) return '—'
  return score > 0 ? `+${score}` : score < 0 ? `−${Math.abs(score)}` : '0'
}

/** "3 prom · 1 neu · 2 det" */
export function resumoFaixas(b: Pick<BlocoAgenteNps, 'promotores' | 'neutros' | 'detratores'>): string {
  return `${b.promotores} prom · ${b.neutros} neu · ${b.detratores} det`
}
