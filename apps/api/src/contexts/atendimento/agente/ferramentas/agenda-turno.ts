import type { QuandoDoTurno } from '@geracrm/shared'

/**
 * O QUE `agendar_reuniao` FEZ NESTE TURNO — a ponte entre a ferramenta e as etapas `reuniao` do
 * pipeline (guarda da resposta e pós-envio), sem tocar em `vendedor.ts` (ADR-029).
 *
 * Chave = tenant + conversa + `agora` do turno: a ferramenta (`ContextoFerramenta.agora`) e o
 * pipeline (`ContextoPipeline.agora`) recebem o MESMO instante, e o turno é serial por conversa.
 * Vive em memória do processo, de propósito: é estado de UM turno, que roda inteiro num processo.
 * ⚠️ O pós-envio descarta a entrada; o que sobrar (simulação, falha do modelo) expira em 10 min.
 */
export interface ReuniaoDoTurno {
  /** Algum `agendar_reuniao` rodou (ok ou não). */
  usouFerramenta: boolean
  /** Horários devolvidos pela ferramenta (ofertados e o marcado) — a fonte da guarda (A1). */
  readonly quandos: QuandoDoTurno[]
  /** As linhas "n) quando com X" montadas pelo código na oferta deste turno (A3). */
  linhasOfertadas: string[]
  /** Oferta gravada neste turno (autônomo); só vira confirmável no pós-envio. */
  ofertaId: string | null
  /** Evento criado neste turno (autônomo). */
  agendado: { readonly eventoId: string; readonly usuarioId: string; readonly hora: string; readonly quando: string; readonly contato: string } | null
}

const TTL_MS = 10 * 60_000
const turnos = new Map<string, { em: number; r: ReuniaoDoTurno }>()

export const chaveDoTurno = (tenantId: string, conversaId: string, agora: Date): string => `${tenantId}|${conversaId}|${agora.getTime()}`

function podar(agora: number): void {
  for (const [k, v] of turnos) if (agora - v.em > TTL_MS) turnos.delete(k)
}

/** O registro do turno, criado vazio na primeira vez. */
export function reuniaoDoTurno(chave: string): ReuniaoDoTurno {
  const agora = Date.now()
  podar(agora)
  let e = turnos.get(chave)
  if (!e) {
    e = { em: agora, r: { usouFerramenta: false, quandos: [], linhasOfertadas: [], ofertaId: null, agendado: null } }
    turnos.set(chave, e)
  }
  return e.r
}

/** Só lê (null = a ferramenta não rodou neste turno). */
export const lerReuniaoDoTurno = (chave: string): ReuniaoDoTurno | null => turnos.get(chave)?.r ?? null

export function descartarReuniaoDoTurno(chave: string): void { turnos.delete(chave) }
