/** Tipos de tarefa (follow-up) — espelha o CHECK da migration 0114. */
export const TIPOS_TAREFA = ['ligacao', 'whatsapp', 'reuniao', 'email', 'visita', 'outro'] as const
export type TipoTarefa = (typeof TIPOS_TAREFA)[number]

export function ehTipoTarefa(v: unknown): v is TipoTarefa {
  return typeof v === 'string' && (TIPOS_TAREFA as readonly string[]).includes(v)
}

export interface EntradaSemProximoPasso {
  /** Tarefas ABERTAS com vencimento no futuro (as atrasadas não são "próximo passo"). */
  readonly tarefasAbertasFuturas: number
  /** Eventos de agenda futuros do contato. */
  readonly eventosFuturos: number
  /** Eventos só contam quando o módulo Agenda está ativo no tenant. */
  readonly moduloAgendaAtivo: boolean
}

/**
 * "Sem próximo passo": o contato não tem tarefa aberta futura e — só com o módulo Agenda ligado —
 * nenhum evento futuro. Função pura, compartilhada por API e telas.
 */
export function semProximoPasso(e: EntradaSemProximoPasso): boolean {
  const eventos = e.moduloAgendaAtivo ? e.eventosFuturos : 0
  return e.tarefasAbertasFuturas <= 0 && eventos <= 0
}
