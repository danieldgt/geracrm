import { createHmac } from 'node:crypto'
import type { Sql } from '../../db/index.js'

/**
 * Despachante de webhooks de saída (INT-07).
 *
 * ⚠️ Entrega por CURSOR no outbox: para cada webhook, pega os eventos com
 * id > cursor, entrega os que casam com `eventos` (vazio = todos), e avança o
 * cursor. Falha NÃO avança — retenta com backoff. Depois de MAX tentativas no
 * mesmo evento, dead-letter: registra o erro, PULA o evento e destrava a fila.
 *
 * ⚠️ Roda como DONO (worker, sem tenant de sessão) — o isolamento vem do
 * `tenant_id` explícito em cada query, como o integrador.
 */
const LOTE = 20
const MAX_TENTATIVAS = 8
const TIMEOUT_MS = 8_000

/** Assinatura HMAC-SHA256 do corpo, em hex. O receptor valida com o segredo. */
export function assinar(corpo: string, segredo: string): string {
  return createHmac('sha256', segredo).update(corpo).digest('hex')
}

/** Backoff exponencial com teto (segundos): 30, 60, 120, … até 1h. */
export function backoffSegundos(tentativas: number): number {
  return Math.min(3600, 30 * 2 ** Math.max(0, tentativas - 1))
}

export interface Webhook {
  tenant_id: string; id: string; url: string; eventos: string[]; segredo: string; cursor: string
}
interface EventoOutbox {
  id: string; tipo: string; agregado: string; agregado_id: string | null; payload: unknown; criado_em: Date
}

export type FetchFn = (url: string, init: {
  method: string; headers: Record<string, string>; body: string; signal: AbortSignal
}) => Promise<{ ok: boolean; status: number }>

export interface EstadoEntrega {
  cursor: string
  tentativas: number
  proximaEm: Date | null
  ultimoErro: string | null
  entregou: boolean
}

/** Monta o corpo entregue a partir de um evento do outbox (payload mínimo). */
function corpoDe(ev: EventoOutbox): string {
  return JSON.stringify({
    id: Number(ev.id), tipo: ev.tipo, agregado: ev.agregado,
    agregadoId: ev.agregado_id, payload: ev.payload, ocorridoEm: ev.criado_em,
  })
}

/**
 * Entrega o próximo lote de UM webhook. `tentativasAtuais` é o retry acumulado
 * no evento da cabeça da fila. Retorna o novo estado a persistir. A rede entra
 * pelo `fetchFn` (testável sem sair para o mundo).
 */
export async function entregarLote(
  sql: Sql, fetchFn: FetchFn, wh: Webhook, tentativasAtuais: number, agora: Date,
): Promise<EstadoEntrega> {
  const eventos = await sql<EventoOutbox[]>`
    SELECT id, tipo, agregado, agregado_id, payload, criado_em
      FROM outbox
     WHERE tenant_id = ${wh.tenant_id} AND id > ${wh.cursor}
     ORDER BY id ASC LIMIT ${LOTE}`

  let cursor = wh.cursor
  let entregou = false
  let tentativas = tentativasAtuais

  for (const ev of eventos) {
    // Fora do filtro: não entrega, mas o cursor avança (não reprocessa).
    if (wh.eventos.length > 0 && !wh.eventos.includes(ev.tipo)) {
      cursor = ev.id
      continue
    }

    const corpo = corpoDe(ev)
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    let ok = false
    let status = 0
    try {
      const r = await fetchFn(wh.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-geracrm-event': ev.tipo,
          'x-geracrm-delivery': String(ev.id),
          'x-geracrm-signature': `sha256=${assinar(corpo, wh.segredo)}`,
        },
        body: corpo,
        signal: ctrl.signal,
      })
      ok = r.ok; status = r.status
    } catch { /* rede/timeout → falha */ } finally { clearTimeout(t) }

    if (ok) {
      cursor = ev.id
      entregou = true
      tentativas = 0 // entregou a cabeça: zera o retry para o próximo evento
      continue
    }

    // Falhou este evento. Dead-letter se estourou; senão retenta com backoff.
    const proximas = tentativas + 1
    if (proximas >= MAX_TENTATIVAS) {
      return {
        cursor: ev.id, tentativas: 0, proximaEm: null,
        ultimoErro: `dead-letter após ${MAX_TENTATIVAS} tentativas (status ${status}) no evento ${ev.id}`,
        entregou,
      }
    }
    return {
      cursor, tentativas: proximas,
      proximaEm: new Date(agora.getTime() + backoffSegundos(proximas) * 1000),
      ultimoErro: `falha ao entregar evento ${ev.id} (status ${status})`, entregou,
    }
  }

  // Lote inteiro entregue (ou pulado) sem falha: cursor no fim, zera retry.
  return { cursor, tentativas: 0, proximaEm: null, ultimoErro: null, entregou }
}

/**
 * Uma passada por todos os webhooks ATIVOS e DEVIDOS. Guardada por advisory
 * lock: só uma instância despacha por vez (evita entrega dupla multi-instância).
 */
export async function despacharTodos(sql: Sql, fetchFn: FetchFn, agora: Date): Promise<number> {
  const [trava] = await sql<{ ok: boolean }[]>`SELECT pg_try_advisory_lock(hashtext('webhook_saida_despacho')) AS ok`
  if (!trava?.ok) return 0
  try {
    const webhooks = await sql<(Webhook & { tentativas: number })[]>`
      SELECT tenant_id, id, url, eventos, segredo, cursor, tentativas
        FROM webhook_saida
       WHERE ativo = true AND (proxima_em IS NULL OR proxima_em <= ${agora})`
    let entregas = 0
    for (const wh of webhooks) {
      const r = await entregarLote(sql, fetchFn, wh, wh.tentativas, agora)
      if (r.entregou) entregas++
      await sql`
        UPDATE webhook_saida
           SET cursor = ${r.cursor}, tentativas = ${r.tentativas}, proxima_em = ${r.proximaEm},
               ultimo_erro = ${r.ultimoErro},
               entregue_em = ${r.entregou ? agora : sql`entregue_em`}
         WHERE tenant_id = ${wh.tenant_id} AND id = ${wh.id}`
    }
    return entregas
  } finally {
    await sql`SELECT pg_advisory_unlock(hashtext('webhook_saida_despacho'))`
  }
}
