/**
 * ESTADO DO PROVEDOR DE IA NO PROCESSO — STUB da raia P5 (ADR-030).
 *
 * Contrato a preencher (P5): 2 falhas de provedor seguidas → reserva por N
 * min (`IA_RESERVA_JANELA_MIN`, alerta `llm_reserva_ativo`), volta sozinho;
 * `acesso_negado` → modelo bloqueado 1h (alerta `modelo_bloqueado`).
 * `estadoDoLlm()` é lido pela saúde detalhada (P8).
 *
 * ⚠️ Enquanto stub: sempre principal, nada bloqueado.
 */
export interface EstadoDoLlm {
  readonly situacao: 'principal' | 'reserva'
  /** Até quando a reserva fica ativa; null = no principal. */
  readonly reservaAteEm: Date | null
  readonly falhasSeguidas: number
  readonly modelosBloqueados: readonly { readonly modelo: string; readonly ateEm: Date }[]
}

export function estadoDoLlm(): EstadoDoLlm {
  return { situacao: 'principal', reservaAteEm: null, falhasSeguidas: 0, modelosBloqueados: [] }
}
