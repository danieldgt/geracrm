import { LIMITES_SAUDE_PADRAO, type HorizonteParticao } from '@geracrm/shared'
import type { Sql } from '../db/index.js'

/**
 * WORKER DE PARTIÇÕES MENSAIS (migration 0110) — agendado em `server.ts`, uma
 * passada no boot e depois uma por dia.
 *
 * `auditoria`, `mensagem`, `venda` e `item_venda` são particionadas por mês. Sem
 * a partição do mês seguinte, o INSERT falha no dia 1º ("no partition of
 * relation found for row") — o inbox para de receber mensagem. As migrations
 * só criaram partição até ~12 meses depois do dia em que rodaram; este worker
 * mantém SEMPRE `MESES_A_FRENTE` meses completos à frente do mês corrente.
 *
 * Cada passada, por tabela do registro (`tabelas_particionadas_por_mes()`),
 * numa transação curta:
 *   1. `pg_try_advisory_xact_lock` — outra instância na mesma tabela: pula
 *      (ela está fazendo o mesmo trabalho);
 *   2. `lock_timeout` curto — `CREATE TABLE … PARTITION OF` pega ACCESS EXCLUSIVE
 *      na tabela-mãe; com a `mensagem` ocupada, desiste em segundos e tenta no
 *      dia seguinte (há 12 meses de folga), em vez de enfileirar o inbox atrás;
 *   3. `garantir_particoes_mensais(tabela, MESES_A_FRENTE, 0, agora)` —
 *      idempotente: mês já coberto é pulado. Na passada normal não cria nada e
 *      não pega trava nenhuma na tabela.
 * Depois lê o horizonte de todas. Menos de `particoesMinMeses` (3) em alguma =
 * a manutenção não está acontecendo (worker parado há meses, ou falhando todo
 * dia): `curtas` no relatório → `server.ts` loga com o campo `"alerta"` e o
 * `/saude/detalhada` fica degradado (`particoes_curtas`).
 *
 * ⚠️ Sem tenant: é manutenção de schema, como dono. Nenhuma linha de negócio é
 *    lida — só o catálogo do Postgres. Por isso o alerta é DE PROCESSO (log +
 *    motivo na saúde), não linha na tabela `alerta`, que é por tenant e sob RLS
 *    (skill geracrm-observabilidade, "Alertas do produto").
 */
export const INTERVALO_PARTICOES_MS = 24 * 3_600_000
/** Primeira passada logo depois do boot: deploy mais frequente que 1×/dia nunca chegaria às 24 h. */
export const ATRASO_PRIMEIRA_PASSADA_PARTICOES_MS = 60_000
/** Meses completos depois do mês corrente que o worker mantém. */
export const MESES_A_FRENTE = 12
/** Teto de espera pela trava da tabela-mãe ao criar partição. */
const LOCK_TIMEOUT = '3s'
/** Código do alerta de processo, no log (`"alerta"`) — a ação está no runbook. */
export const ALERTA_PARTICOES = 'particoes_horizonte_curto'

export interface FalhaParticao {
  readonly tabela: string
  /** SQLSTATE do Postgres (ex.: 55P03 = lock_timeout); nunca a mensagem inteira. */
  readonly codigo: string
}

export interface RelatorioParticoes {
  /** Partições criadas nesta passada (todas as tabelas). */
  readonly processadas: number
  readonly criadas: Readonly<Record<string, number>>
  /** Tabelas puladas porque outra instância segurava a trava. */
  readonly ocupadas: readonly string[]
  readonly falhas: readonly FalhaParticao[]
  readonly horizontes: readonly HorizonteParticao[]
  /** Tabelas com menos de `minimoMeses` à frente DEPOIS da passada — o alerta. */
  readonly curtas: readonly string[]
}

/** Dependências OPCIONAIS — `server.ts` passa `{}`. */
export interface DepsParticoes {
  /** Restringe a passada (testes, com uma tabela particionada própria). Padrão: o registro do banco. */
  readonly tabelas?: readonly string[] | undefined
  readonly mesesAFrente?: number | undefined
  readonly minimoMeses?: number | undefined
  /** Só para teste: troca a criação (simula falha, ex. lock_timeout). */
  readonly garantir?: ((tx: Sql, tabela: string, meses: number, agora: Date) => Promise<number>) | undefined
}

/**
 * Meses COMPLETOS depois do mês corrente (UTC) cobertos até `horizonte`.
 * Horizonte 2027-11-01 visto de 2026-10-19 → 12 (nov/26 … out/27). Só o mês
 * corrente coberto (ou nem ele) → 0.
 */
export function mesesCobertosAFrente(agora: Date, horizonte: Date): number {
  const mesAgora = agora.getUTCFullYear() * 12 + agora.getUTCMonth()
  const mesHorizonte = horizonte.getUTCFullYear() * 12 + horizonte.getUTCMonth()
  // Horizonte no meio de um mês: aquele mês não está completo — e o cálculo é o
  // mesmo, porque o mês do horizonte nunca conta (é o primeiro não coberto).
  return Math.max(0, mesHorizonte - mesAgora - 1)
}

/** Horizonte (cobertura contínua a partir de `agora`) de cada tabela. Só catálogo, nenhuma linha de negócio. */
export async function lerHorizontes(sql: Sql, agora: Date, tabelas?: readonly string[]): Promise<HorizonteParticao[]> {
  const linhas = tabelas
    ? await sql<{ tabela: string; horizonte: Date | null }[]>`
        SELECT t AS tabela, horizonte_particoes(t, ${agora}) AS horizonte
          FROM unnest(${tabelas as string[]}::text[]) AS t`
    : await sql<{ tabela: string; horizonte: Date | null }[]>`
        SELECT t AS tabela, horizonte_particoes(t, ${agora}) AS horizonte
          FROM tabelas_particionadas_por_mes() AS t`
  return linhas.map((l) => ({
    tabela: l.tabela,
    mesesAFrente: l.horizonte ? mesesCobertosAFrente(agora, new Date(l.horizonte)) : 0,
  }))
}

const garantirPadrao = async (tx: Sql, tabela: string, meses: number, agora: Date): Promise<number> => {
  const [r] = await tx<{ criadas: number }[]>`
    SELECT garantir_particoes_mensais(${tabela}, ${meses}::int, 0, ${agora}) AS criadas`
  return r?.criadas ?? 0
}

export async function processarParticoes(
  dono: Sql, deps: DepsParticoes = {}, agora: Date = new Date(),
): Promise<RelatorioParticoes> {
  const meses = deps.mesesAFrente ?? MESES_A_FRENTE
  const minimo = deps.minimoMeses ?? LIMITES_SAUDE_PADRAO.particoesMinMeses
  const garantir = deps.garantir ?? garantirPadrao
  const tabelas = deps.tabelas
    ?? (await dono<{ t: string }[]>`SELECT t FROM tabelas_particionadas_por_mes() AS t`).map((l) => l.t)

  const criadas: Record<string, number> = {}
  const ocupadas: string[] = []
  const falhas: FalhaParticao[] = []
  for (const tabela of tabelas) {
    try {
      const n = await dono.begin(async (tx) => {
        const [trava] = await tx<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext(${`particoes:${tabela}`})) AS ok`
        if (!trava?.ok) return null
        await tx`SELECT set_config('lock_timeout', ${LOCK_TIMEOUT}, true)`
        return garantir(tx as unknown as Sql, tabela, meses, agora)
      }) as number | null
      if (n === null) ocupadas.push(tabela)
      else criadas[tabela] = n
    } catch (e) {
      // Uma tabela que falha (trava ocupada) não impede as outras.
      falhas.push({ tabela, codigo: String((e as { code?: unknown }).code ?? 'desconhecido') })
    }
  }

  const horizontes = await lerHorizontes(dono, agora, tabelas)
  const curtas = horizontes.filter((h) => h.mesesAFrente < minimo).map((h) => h.tabela)
  const processadas = Object.values(criadas).reduce((a, b) => a + b, 0)
  return { processadas, criadas, ocupadas, falhas, horizontes, curtas }
}
