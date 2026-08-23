import type { Sql } from '../../db/index.js'
import { sincronizarConta, type ResumoSincronizacao } from './sincronizador.js'
import { enfileirarConversoesDeVendas } from './enfileirar-conversao.js'
import { despacharDoTenant, type ResultadoDespacho } from './despachante-conversao.js'
import { adaptadorDaPlataforma, configGoogleDoAmbiente } from './plataformas/fabrica.js'
import type { PortaPlataformaMidia } from './plataformas/porta.js'

/**
 * As DUAS varreduras da camada de aquisição, e por que são duas.
 *
 * ⚠️ **A cota decide a cadência.** O nível de acesso do Google limita operações
 * por dia, e o limite é COMPARTILHADO entre todos os clientes. Uma sincronização
 * gasta ~4 requisições por conta (3 de estrutura + 1 de métrica, mais paginação):
 *
 * | Cadência | Requisições/conta/dia | Contas que cabem em 2.880/dia |
 * |---|---|---|
 * | a cada 30 min | ~192 | ⚠️ **15** |
 * | a cada 6 h | ~16 | ~180 |
 *
 * Sincronizar de meia em meia hora não traria nada — **métrica do Google é
 * diária** — e custaria uma ordem de grandeza em clientes atendidos. Por isso a
 * sincronização é folgada e as conversões, que não tocam essa cota enquanto o
 * envio não estiver implementado, correm mais rápido.
 */

/** Métrica do Google fecha por dia; 4 passadas dão folga sem gastar cota à toa. */
export const INTERVALO_SINCRONIZACAO_MS = 6 * 60 * 60 * 1000
/** Conversão não é notificação — a plataforma aceita o fato dentro de dias. */
export const INTERVALO_CONVERSOES_MS = 15 * 60 * 1000

export interface ResumoVarreduraMidia {
  readonly contas: number
  readonly ignoradasPorSeremGerenciador: number
  readonly chamadas: number
  readonly porConta: readonly { contaId: string; resumo: ResumoSincronizacao }[]
}

type FabricaAdaptador = (plataforma: string) => PortaPlataformaMidia

/**
 * Sincroniza a estrutura e o custo de todas as contas de anúncio.
 *
 * ⚠️ Guardada por advisory lock: duas instâncias sincronizando em paralelo
 * gastariam cota em dobro e disputariam os mesmos UPSERTs.
 */
export async function varrerSincronizacaoMidia(
  sql: Sql,
  opcoes: { agora: Date; adaptadorPara?: FabricaAdaptador; env?: NodeJS.ProcessEnv } = { agora: new Date() },
): Promise<ResumoVarreduraMidia> {
  const vazio: ResumoVarreduraMidia = {
    contas: 0, ignoradasPorSeremGerenciador: 0, chamadas: 0, porConta: [],
  }

  const [trava] = await sql<{ ok: boolean }[]>`
    SELECT pg_try_advisory_lock(hashtext('midia_sincronizacao')) AS ok`
  if (!trava?.ok) return vazio

  try {
    const env = opcoes.env ?? process.env
    const criar = opcoes.adaptadorPara ?? ((p: string) => adaptadorDaPlataforma(p, { env }))

    /**
     * ⚠️ O id da MCC, para NÃO sincronizá-la.
     *
     * Descoberto na primeira chamada real (2026-08-23): a conta de gerenciador
     * responde `customer` normalmente, mas recusa métrica com
     * `REQUESTED_METRICS_FOR_MANAGER` — ela só agrega. Se alguém a cadastrar como
     * `midia_conta` por engano, toda passada gastaria cota para falhar. Pular é
     * mais honesto que tentar e registrar erro para sempre.
     */
    const mcc = configGoogleDoAmbiente(env)?.loginCustomerId ?? null

    const contas = await sql<{
      tenant_id: string; id: string; plataforma: string; id_externo: string
    }[]>`
      SELECT tenant_id, id, plataforma, id_externo
        FROM midia_conta WHERE ativo
       ORDER BY tenant_id, criado_em`

    let ignoradas = 0
    let chamadas = 0
    const porConta: { contaId: string; resumo: ResumoSincronizacao }[] = []

    for (const c of contas) {
      if (mcc && c.plataforma === 'google' && c.id_externo.replace(/\D/g, '') === mcc) {
        ignoradas++
        continue
      }
      const resumo = await sincronizarConta(sql, {
        tenantId: c.tenant_id,
        contaId: c.id,
        contaExternaId: c.id_externo,
        adaptador: criar(c.plataforma),
        agora: opcoes.agora,
      })
      chamadas += resumo.chamadas
      porConta.push({ contaId: c.id, resumo })
    }

    return { contas: porConta.length, ignoradasPorSeremGerenciador: ignoradas, chamadas, porConta }
  } finally {
    await sql`SELECT pg_advisory_unlock(hashtext('midia_sincronizacao'))`
  }
}

export interface ResumoVarreduraConversoes {
  readonly tenants: number
  readonly criadas: number
  readonly despacho: ResultadoDespacho
}

/**
 * Enfileira conversões das vendas novas e despacha as pendentes.
 *
 * ⚠️ **Enfileirar ANTES de despachar**, na mesma passada: a venda que o ERP
 * acabou de importar já sai nesta rodada, em vez de esperar a próxima. Inverter
 * a ordem adicionaria um ciclo inteiro de latência sem ganho nenhum.
 */
export async function varrerConversoes(
  sql: Sql,
  opcoes: { agora: Date; adaptadorPara?: FabricaAdaptador; env?: NodeJS.ProcessEnv } = { agora: new Date() },
): Promise<ResumoVarreduraConversoes> {
  const vazio: ResumoVarreduraConversoes = {
    tenants: 0, criadas: 0,
    despacho: { enviadas: 0, descartadas: 0, reagendadas: 0, falhadas: 0 },
  }

  const [trava] = await sql<{ ok: boolean }[]>`
    SELECT pg_try_advisory_lock(hashtext('midia_conversoes')) AS ok`
  if (!trava?.ok) return vazio

  try {
    const env = opcoes.env ?? process.env
    const criar = opcoes.adaptadorPara ?? ((p: string) => adaptadorDaPlataforma(p, { env }))

    // Só tenants que têm origem de mídia — os demais não têm o que devolver.
    const tenants = await sql<{ tenant_id: string }[]>`
      SELECT DISTINCT tenant_id FROM midia_lead_origem`

    let criadas = 0
    const total = { enviadas: 0, descartadas: 0, reagendadas: 0, falhadas: 0 }

    for (const { tenant_id } of tenants) {
      const enf = await enfileirarConversoesDeVendas(sql, tenant_id, opcoes.agora)
      criadas += enf.criadas
      const d = await despacharDoTenant(sql, tenant_id, criar, opcoes.agora)
      total.enviadas += d.enviadas
      total.descartadas += d.descartadas
      total.reagendadas += d.reagendadas
      total.falhadas += d.falhadas
    }

    return { tenants: tenants.length, criadas, despacho: total }
  } finally {
    await sql`SELECT pg_advisory_unlock(hashtext('midia_conversoes'))`
  }
}
