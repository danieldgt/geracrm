import { comTenantServico, type Sql } from '../db/index.js'
import { arquivosBucket, type ArquivosBucket } from '../contexts/crm/arquivos-bucket.js'
import { codigoDoErro } from './lgpd.js'

/**
 * WORKER DE REMOÇÃO DE MÍDIA LGPD (raia H2) — consome `lgpd_midia_pendente`.
 *
 * A anonimização só ANOTA a chave do objeto (na transação dela). Aqui, por tenant:
 *   1. RESERVA um lote vencido (`proxima_tentativa_em <= agora`) empurrando a próxima tentativa
 *      para depois do prazo de reserva — duas instâncias não pegam o mesmo item;
 *   2. chama `remover(chave)` FORA de qualquer transação (rede nunca dentro de transação);
 *   3. sucesso → `removido_em`; falha → `tentativas + 1`, `ultimo_erro` (só o CÓDIGO) e backoff
 *      exponencial (1 min, 2, 4… até 24 h). Nunca desiste: o painel mostra o que segue pendente.
 *
 * Sem bucket configurado (`disponivel() = false`): não reserva nada — degrada, não quebra.
 * ⚠️ Log só com contagens; a chave do objeto não é dado pessoal, mas também não vai para log.
 */
export const INTERVALO_LGPD_MIDIA_MS = 10 * 60_000
export const ATRASO_PRIMEIRA_PASSADA_LGPD_MIDIA_MS = 3 * 60_000
const LOTE = 50
const RESERVA_MS = 10 * 60_000
const BACKOFF_BASE_MS = 60_000
const BACKOFF_MAX_MS = 24 * 3_600_000

export interface RelatorioLgpdMidia {
  readonly removidas: number
  readonly falhas: number
  readonly semBucket: boolean
}

export interface DepsLgpdMidia {
  readonly somenteTenant?: string | undefined
  readonly lote?: number | undefined
  readonly bucket?: ArquivosBucket | undefined
}

/** Atraso até a próxima tentativa depois de `tentativas` falhas (1 → 1 min, 2 → 2 min, …, teto 24 h). */
export function backoffMidiaMs(tentativas: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, tentativas - 1))
}

export async function processarMidiaLgpd(dono: Sql, deps: DepsLgpdMidia = {}, agora: Date = new Date()): Promise<RelatorioLgpdMidia> {
  const bucket = deps.bucket ?? arquivosBucket()
  if (!bucket.disponivel()) return { removidas: 0, falhas: 0, semBucket: true }
  const lote = deps.lote ?? LOTE
  const tenants = await dono<{ tenant_id: string }[]>`
    SELECT DISTINCT tenant_id FROM lgpd_midia_pendente
     WHERE removido_em IS NULL AND proxima_tentativa_em <= ${agora}::timestamptz
       AND ${deps.somenteTenant ? dono`tenant_id = ${deps.somenteTenant}` : dono`true`}`

  let removidas = 0, falhas = 0
  for (const { tenant_id: tenantId } of tenants) {
    const reservados = await comTenantServico(tenantId, (tx) => tx<{ id: string; chave_objeto: string; tentativas: number }[]>`
      UPDATE lgpd_midia_pendente l
         SET proxima_tentativa_em = ${new Date(agora.getTime() + RESERVA_MS)}::timestamptz
        FROM (SELECT id FROM lgpd_midia_pendente
               WHERE tenant_id = tenant_atual() AND removido_em IS NULL AND proxima_tentativa_em <= ${agora}::timestamptz
               ORDER BY proxima_tentativa_em, id
               LIMIT ${lote}
               FOR UPDATE SKIP LOCKED) s
       WHERE l.tenant_id = tenant_atual() AND l.id = s.id
      RETURNING l.id, l.chave_objeto, l.tentativas`)

    for (const r of reservados) {
      // ⚠️ Fora de transação: a chamada de rede não segura conexão nem trava linha.
      let codigo: string | null = null
      try { await bucket.remover(r.chave_objeto) } catch (e) { codigo = codigoDoErro(e) }
      if (codigo === null) {
        removidas++
        await comTenantServico(tenantId, (tx) => tx`
          UPDATE lgpd_midia_pendente SET removido_em = ${agora}::timestamptz, ultimo_erro = NULL
           WHERE tenant_id = tenant_atual() AND id = ${r.id}`)
      } else {
        falhas++
        const tentativas = r.tentativas + 1
        await comTenantServico(tenantId, (tx) => tx`
          UPDATE lgpd_midia_pendente
             SET tentativas = least(${tentativas}, 32767), ultimo_erro = ${codigo.slice(0, 80)},
                 proxima_tentativa_em = ${new Date(agora.getTime() + backoffMidiaMs(tentativas))}::timestamptz
           WHERE tenant_id = tenant_atual() AND id = ${r.id}`)
      }
    }
  }
  return { removidas, falhas, semBucket: false }
}
