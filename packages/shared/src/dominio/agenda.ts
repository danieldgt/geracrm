/**
 * AGENDA (módulo opcional, raia C2) — vocabulário compartilhado por API e console.
 * Espelha os CHECKs da migration 0117. TypeScript puro.
 */
export const TIPOS_EVENTO = ['reuniao', 'ligacao', 'visita', 'outro'] as const
export type TipoEvento = (typeof TIPOS_EVENTO)[number]

export const MODALIDADES_EVENTO = ['presencial', 'online'] as const
export type ModalidadeEvento = (typeof MODALIDADES_EVENTO)[number]

export const STATUS_EVENTO = ['agendado', 'realizado', 'nao_compareceu', 'cancelado'] as const
export type StatusEvento = (typeof STATUS_EVENTO)[number]

/** Antecedência do lembrete, em minutos (5 min … 1 dia). */
export const LEMBRETES_EVENTO_MIN = [5, 15, 30, 60, 1440] as const
export type LembreteEventoMin = (typeof LEMBRETES_EVENTO_MIN)[number]

/** NOMES de token da paleta — nunca hex. O console resolve para a variável CSS. */
export const CORES_EVENTO = ['acao', 'sucesso', 'atencao', 'erro', 'ia', 'neutro'] as const
export type CorEvento = (typeof CORES_EVENTO)[number]

/** Janela máxima de consulta do calendário, em dias (é janela de calendário, não lista). */
export const JANELA_AGENDA_MAX_DIAS = 62

const em = (lista: readonly unknown[], v: unknown): boolean => lista.includes(v)
export const ehTipoEvento = (v: unknown): v is TipoEvento => em(TIPOS_EVENTO, v)
export const ehModalidadeEvento = (v: unknown): v is ModalidadeEvento => em(MODALIDADES_EVENTO, v)
export const ehStatusEvento = (v: unknown): v is StatusEvento => em(STATUS_EVENTO, v)
export const ehLembreteEvento = (v: unknown): v is LembreteEventoMin => em(LEMBRETES_EVENTO_MIN, v)
export const ehCorEvento = (v: unknown): v is CorEvento => em(CORES_EVENTO, v)

/** Contrato do evento na API (datas em ISO 8601). */
export interface EventoAgenda {
  readonly id: string
  readonly titulo: string
  readonly descricao: string | null
  readonly contatoId: string | null
  readonly contato: string | null
  readonly responsavelId: string
  readonly responsavel: string | null
  readonly inicio: string
  readonly fim: string
  readonly tipo: TipoEvento
  readonly modalidade: ModalidadeEvento
  readonly local: string | null
  readonly link: string | null
  readonly lembreteMin: LembreteEventoMin | null
  readonly cor: CorEvento
  readonly status: StatusEvento
  readonly versao: number
}

/** Dois intervalos [inicio, fim) se sobrepõem? Puro; fronteira encostada NÃO conflita. */
export function periodosSobrepoem(
  a: { inicio: Date | string; fim: Date | string }, b: { inicio: Date | string; fim: Date | string },
): boolean {
  return new Date(a.inicio).getTime() < new Date(b.fim).getTime() && new Date(a.fim).getTime() > new Date(b.inicio).getTime()
}
