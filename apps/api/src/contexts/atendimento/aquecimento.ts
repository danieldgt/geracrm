import type { Sql } from '../../db/index.js'
import { fusoSeguro } from '../plataforma/fuso.js'
import { instanteLocal, partesLocais } from './expediente.js'

/**
 * Aquecimento de frota (Onda 3). ⚠️ O teto diário de disparo PROATIVO de um
 * número não-oficial cresce aos poucos — subir de 0 a 1000 no dia 1 queima o
 * número (ADR-021). A rampa é pura e explicável.
 */

/** Teto diário de disparo por dia de aquecimento (0-based). Ramp ~1.6×/dia, teto 1000. */
export function limiteDiario(dia: number): number {
  const base = 20
  const teto = 1000
  return Math.min(teto, Math.round(base * Math.pow(1.6, Math.max(0, dia))))
}

export interface StatusAquecimento {
  readonly emAquecimento: boolean
  readonly dia: number
  readonly limiteHoje: number
  readonly usadoHoje: number
  readonly restante: number
}

/** Início do dia de `agora` no fuso do tenant (sob RLS) — "hoje" é o dia da loja, não o do servidor. */
export async function inicioDoDiaDoTenant(sql: Sql, agora: Date): Promise<Date> {
  const [t] = await sql<{ fuso: string | null }[]>`SELECT fuso FROM tenant WHERE id = tenant_atual()`
  const fuso = fusoSeguro(t?.fuso)
  return instanteLocal(partesLocais(agora, fuso).data, '00:00', fuso)
}

/** Reativações (G5) ENVIADAS hoje (dia do tenant) por este número. */
export async function reativacoesEnviadasHoje(sql: Sql, canalId: string, desde: Date): Promise<number> {
  const [r] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM agente_retorno
     WHERE tenant_id = tenant_atual() AND canal_id = ${canalId}
       AND motivo = 'reativacao' AND estado = 'enviado' AND concluido_em >= ${desde}`
  return r?.n ?? 0
}

/**
 * Status de aquecimento de um número: dia, teto de hoje, quanto já disparou hoje
 * (envios de campanha por este canal, legado e v2, + reativações do agente, G5) e quanto
 * resta. "Hoje" é o dia no fuso do tenant. Sem registro de aquecimento → sem
 * teto (número já quente / oficial).
 */
export async function statusAquecimento(sql: Sql, canalId: string, agora: Date): Promise<StatusAquecimento> {
  const [aq] = await sql<{ iniciado_em: Date }[]>`
    SELECT iniciado_em FROM canal_aquecimento
     WHERE tenant_id = tenant_atual() AND canal_id = ${canalId} AND ativo`
  if (!aq) return { emAquecimento: false, dia: 0, limiteHoje: Infinity, usadoHoje: 0, restante: Infinity }

  const dia = Math.floor((agora.getTime() - aq.iniciado_em.getTime()) / 86_400_000)
  const limiteHoje = limiteDiario(dia)

  // Disparos de campanha por ESTE número, hoje — e as reativações do agente, que
  // também são mensagem proativa a quem não está conversando (consomem a mesma cota).
  const desde = await inicioDoDiaDoTenant(sql, agora)
  const [uso] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n
      FROM campanha_envio ce
      JOIN campanha c ON c.tenant_id = ce.tenant_id AND c.id = ce.campanha_id
     WHERE ce.tenant_id = tenant_atual() AND c.canal_id = ${canalId}
       AND ce.estado = 'enviado' AND ce.enviado_em >= ${desde}`
  // Campanha v2 (F1): o que saiu hoje por este número e o que está SAINDO agora
  // (reivindicado por um worker, ainda sem desfecho) — senão duas passadas
  // simultâneas leriam o mesmo "resta" e estourariam o teto juntas.
  const [usoV2] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n
      FROM campanha_destinatario d
      JOIN campanha c ON c.tenant_id = d.tenant_id AND c.id = d.campanha_id
     WHERE d.tenant_id = tenant_atual() AND c.canal_id = ${canalId}
       AND (d.enviado_em >= ${desde} OR d.estado = 'enviando')`
  const usadoHoje = (uso?.n ?? 0) + (usoV2?.n ?? 0) + await reativacoesEnviadasHoje(sql, canalId, desde)
  return { emAquecimento: true, dia, limiteHoje, usadoHoje, restante: Math.max(0, limiteHoje - usadoHoje) }
}
