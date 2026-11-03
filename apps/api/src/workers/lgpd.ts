import { comTenantServico, type Sql } from '../db/index.js'
import { anonimizarContato, candidatosDeAnonimizacao } from '../contexts/crm/lgpd-anonimizacao.js'

/**
 * WORKER DE RETENÇÃO LGPD (raia H2) — agendado em `server.ts` (1×/dia, com batimento).
 *
 * Por tenant (como DONO só para listar os tenants; todo o resto sob `comTenantServico`, RLS):
 *   1. lê até `LOTE` candidatos (descartados além da retenção e opt-outs com mais de 15 dias —
 *      regras em `lgpd-anonimizacao.ts`);
 *   2. anonimiza CADA contato na sua própria transação (uma falha não desfaz os outros);
 *   3. repete até `MAX_LOTES_POR_TENANT` lotes ou até estourar o orçamento de tempo — o que sobrar
 *      é pego na próxima passada (os já anonimizados saem dos candidatos: a retomada é natural).
 *
 * ⚠️ Nunca varre a base numa transação só: seletor por índice parcial, `LIMIT`, contato a contato.
 * ⚠️ Log só com contagens e códigos — nunca nome, telefone ou texto de contato.
 * Idempotente: duas passadas simultâneas disputam a linha (`FOR UPDATE`) e a segunda vê
 * `jaAnonimizado`.
 */
export const INTERVALO_LGPD_MS = 24 * 3_600_000
/** Primeira passada logo depois do boot (deploy mais frequente que 1×/dia nunca chegaria às 24 h). */
export const ATRASO_PRIMEIRA_PASSADA_LGPD_MS = 5 * 60_000
const LOTE = 200
const MAX_LOTES_POR_TENANT = 5
const ORCAMENTO_PADRAO_MS = 60_000

export interface RelatorioLgpdWorker {
  readonly processadas: number
  readonly anonimizados: number
  readonly falhas: number
  /** Parou por orçamento de tempo antes de zerar os candidatos — retoma no próximo ciclo. */
  readonly interrompido: boolean
}

export interface DepsLgpd {
  readonly somenteTenant?: string | undefined
  readonly orcamentoMs?: number | undefined
  readonly lote?: number | undefined
  /** Relógio injetável para o orçamento (testes). */
  readonly relogio?: (() => number) | undefined
  /** Só para teste: roda depois de cada contato processado. */
  readonly depoisDoContato?: (() => void) | undefined
}

export async function processarLgpd(dono: Sql, deps: DepsLgpd = {}, agora: Date = new Date()): Promise<RelatorioLgpdWorker> {
  const relogio = deps.relogio ?? Date.now
  const limite = relogio() + (deps.orcamentoMs ?? ORCAMENTO_PADRAO_MS)
  const lote = deps.lote ?? LOTE
  const tenants = await dono<{ id: string }[]>`
    SELECT id FROM tenant WHERE ${deps.somenteTenant ? dono`id = ${deps.somenteTenant}` : dono`true`} ORDER BY id`

  let processadas = 0, anonimizados = 0, falhas = 0, interrompido = false
  for (const t of tenants) {
    for (let n = 0; n < MAX_LOTES_POR_TENANT; n++) {
      if (relogio() >= limite) { interrompido = true; break }
      const candidatos = await comTenantServico(t.id, (tx) => candidatosDeAnonimizacao(tx, { agora, limite: lote }))
      if (candidatos.length === 0) break
      let progresso = 0
      for (const c of candidatos) {
        if (relogio() >= limite) { interrompido = true; break }
        processadas++
        try {
          const r = await comTenantServico(t.id, (tx) => anonimizarContato(tx, c.id, { motivo: c.motivo, agora }))
          if (r.ok && !r.jaAnonimizado) { anonimizados++; progresso++ }
          else if (!r.ok) falhas++
        } catch {
          falhas++
        }
        deps.depoisDoContato?.()
      }
      // Sem progresso (só recusas/falhas): não repete o mesmo lote em laço.
      if (interrompido || progresso === 0) break
    }
    if (interrompido) break
  }
  return { processadas, anonimizados, falhas, interrompido }
}
