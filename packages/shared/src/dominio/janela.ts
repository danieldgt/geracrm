/**
 * 24-hour customer service window (Meta rule).
 *
 * This is the single source of truth for INV-18. The same function feeds:
 *  - the countdown in the conversation header (console and app)
 *  - the composer mode switch (free text vs. template only)
 *  - the server-side guard in the outbound message gateway
 *
 * Keeping it here — pure, in @geracrm/shared — is what prevents the classic bug:
 * the UI allowing a message the server then rejects.
 *
 * Task E3-10 · INV-18 · INB-04/INB-05
 */

/** Meta's window is 24h counted from the customer's last INBOUND message. */
export const JANELA_DURACAO_MS = 24 * 60 * 60 * 1000

/** Below this, the UI switches the ring/bar to the "ending" colour (tokens.janela). */
export const JANELA_ATENCAO_MS = 2 * 60 * 60 * 1000

export type EstadoJanela = 'aberta' | 'terminando' | 'fechada'

export interface Janela {
  readonly estado: EstadoJanela
  readonly aberta: boolean
  /** Milliseconds left; 0 when closed. */
  readonly restanteMs: number
  /** When it closes; null when there was never an inbound message. */
  readonly expiraEm: Date | null
  /** 0..1 — how much of the window is still available. Drives the signature ring. */
  readonly fracaoRestante: number
}

/**
 * @param ultimaEntranteEm  timestamp of the customer's last inbound message, or null
 * @param agora             injected clock — never read the system time in here (testability)
 */
export function calcularJanela(ultimaEntranteEm: Date | null, agora: Date): Janela {
  if (ultimaEntranteEm === null) {
    return { estado: 'fechada', aberta: false, restanteMs: 0, expiraEm: null, fracaoRestante: 0 }
  }

  const expiraEm = new Date(ultimaEntranteEm.getTime() + JANELA_DURACAO_MS)
  const restanteMs = expiraEm.getTime() - agora.getTime()

  // Exactly at 24h the window is CLOSED — Meta rejects it. The boundary tests
  // (23h open, 24h closed) exist precisely because this is where it breaks.
  if (restanteMs <= 0) {
    return { estado: 'fechada', aberta: false, restanteMs: 0, expiraEm, fracaoRestante: 0 }
  }

  return {
    estado: restanteMs <= JANELA_ATENCAO_MS ? 'terminando' : 'aberta',
    aberta: true,
    restanteMs,
    expiraEm,
    fracaoRestante: restanteMs / JANELA_DURACAO_MS,
  }
}

/** Free-form text is only allowed inside an open window; otherwise an approved template. */
export function permiteTextoLivre(janela: Janela): boolean {
  return janela.aberta
}
