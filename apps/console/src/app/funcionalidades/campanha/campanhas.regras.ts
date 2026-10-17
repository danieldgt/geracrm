/**
 * Regras de apresentação da tela de campanhas (sem Angular — testável em Vitest puro).
 */

/** O número da campanha teve as ativas suspensas pela Meta (P11): o despachante segura a fila. */
export interface PausaPorQualidade {
  readonly desde: string
  /** `qualidade:…` (volta sozinha) ou `conta:…` (alguém libera na tela do agente). */
  readonly motivo: string | null
}

/**
 * O aviso que a campanha em curso mostra quando o número está suspenso. Diz o
 * que aconteceu e o que acontece depois — nada é perdido, a fila espera.
 */
export function avisoDePausa(p: PausaPorQualidade | null | undefined): { titulo: string; detalhe: string } | null {
  if (!p) return null
  if ((p.motivo ?? '').startsWith('conta:')) {
    return {
      titulo: 'Pausada: a Meta restringiu a conta do número',
      detalhe: 'Os envios pendentes esperam. Confira a conta no Gerenciador do WhatsApp e libere as ativas na tela do agente.',
    }
  }
  return {
    titulo: 'Pausada por qualidade do número',
    detalhe: 'A qualidade do número caiu na Meta. Os envios pendentes esperam e a campanha retoma sozinha quando a qualidade normalizar.',
  }
}
