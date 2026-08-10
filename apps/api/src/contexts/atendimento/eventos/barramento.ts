import { sql } from '../../../db/index.js'

/**
 * Barramento de tempo real (ADR-007) — SSE + Postgres LISTEN/NOTIFY, sem broker.
 *
 * ⚠️ Área de MAIOR risco de segurança: um erro aqui entrega conversa de uma
 * empresa para outra. Duas defesas:
 *  1. o fan-out para as abas é filtrado por `tenantId` (o do token, no servidor);
 *  2. o evento entregue ao cliente NÃO carrega conteúdo — só ids. Se o alvo
 *     errar, o intruso recebe um id que a API (sob RLS) não resolve.
 *
 * ⚠️ Escala: UMA conexão LISTEN por INSTÂNCIA. Um NOTIFY chega em todas as
 * instâncias; cada uma empurra para as abas SSE que ela mantém. É o que deixa
 * escalar o backend horizontalmente sem Redis/MQTT — o Postgres faz o fan-out.
 */

/** Evento no fio interno (NOTIFY) — ids apenas, jamais conteúdo. */
export interface EventoTempoReal {
  readonly tenantId: string
  readonly id: number // cursor = id do outbox
  readonly tipo: string
  readonly conversaId?: string
  readonly canalId?: string
  readonly versao?: number
}

/** O que chega na aba: SEM tenantId e SEM conteúdo. */
export interface EventoCliente {
  readonly id: number
  readonly tipo: string
  readonly conversaId?: string
  readonly versao?: number
}

const CANAL_PG = 'geracrm_evento'

type Assinante = (ev: EventoCliente) => void
const porTenant = new Map<string, Set<Assinante>>()
let ouvindo = false

/** Assina os eventos de UM tenant. Devolve a função de cancelamento. */
export function assinar(tenantId: string, fn: Assinante): () => void {
  let set = porTenant.get(tenantId)
  if (!set) {
    set = new Set()
    porTenant.set(tenantId, set)
  }
  set.add(fn)
  return () => {
    const s = porTenant.get(tenantId)
    if (!s) return
    s.delete(fn)
    if (s.size === 0) porTenant.delete(tenantId)
  }
}

/** ⚠️ Só entrega para as abas do MESMO tenant, e sem tenantId/conteúdo. */
function despachar(ev: EventoTempoReal): void {
  const set = porTenant.get(ev.tenantId)
  if (!set || set.size === 0) return
  const cliente: EventoCliente = {
    id: ev.id,
    tipo: ev.tipo,
    ...(ev.conversaId ? { conversaId: ev.conversaId } : {}),
    ...(ev.versao !== undefined ? { versao: ev.versao } : {}),
  }
  for (const fn of set) {
    try {
      fn(cliente)
    } catch {
      // Uma aba que falha ao escrever não pode derrubar as outras.
    }
  }
}

/** Exposto para teste do fan-out sem depender do Postgres. */
export function despacharParaTeste(ev: EventoTempoReal): void {
  despachar(ev)
}

/**
 * UMA conexão LISTEN por instância. Chamar no boot do servidor (não em teste).
 *
 * ⚠️ Quem PUBLICA é a TRIGGER do outbox (migration 0026): todo INSERT na outbox
 * dispara `pg_notify('geracrm_evento', …)` no COMMIT. Não há publish no código —
 * é transacional por construção e vale para qualquer produtor futuro.
 */
export async function iniciarBarramento(): Promise<void> {
  if (ouvindo) return
  ouvindo = true
  await sql.listen(CANAL_PG, (payload) => {
    try {
      despachar(JSON.parse(payload) as EventoTempoReal)
    } catch {
      // Payload malformado no canal — ignora, não derruba o LISTEN.
    }
  })
}
