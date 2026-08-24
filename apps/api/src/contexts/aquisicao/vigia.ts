import { randomUUID } from 'node:crypto'
import type { Sql } from '../../db/index.js'

/**
 * VIGIA DE ANOMALIA DA MÍDIA (AQ-07).
 *
 * Reusa a infraestrutura que já existe (`alerta`, migration `0031`): dedup por
 * índice parcial, resolução automática, evento no outbox só quando o alerta
 * NASCE. Nada de tabela nova.
 *
 * ⚠️ **Toda regra exige massa mínima.** Alertar com 2 cliques é ruído, e ruído
 * treina o operador a ignorar alerta — que é pior do que não ter alerta nenhum.
 * É a mesma disciplina do `avaliarEntrega` (massa 20, limiar 70%).
 *
 * ⚠️ E toda regra é PURA: decide sobre números, sem tocar no banco. O que toca no
 * banco é a varredura, que só junta as peças.
 */

export type TipoAlertaMidia =
  | 'midia_gasto_anomalo'
  | 'midia_veiculacao_parada'
  | 'midia_leads_sumiram'
  | 'midia_codigo_perdido'
  | 'midia_conversoes_falhando'

export interface Anomalia {
  readonly tipo: TipoAlertaMidia
  readonly severidade: 'aviso' | 'critico'
  readonly mensagem: string
}

/** Limiares num lugar só. ⚠️ Fora daqui não existe número mágico solto. */
export const REGRAS = {
  /** Dias de histórico para formar a linha de base. Menos que isso é chute. */
  diasBase: 7,
  /** Gasto do dia acima de N× a média da base = anomalia. */
  fatorGasto: 3,
  /** Abaixo deste gasto diário (centavos) a variação é ruído, não sinal. */
  gastoMinimoRelevante: 5_000,
  /** Cliques mínimos no período para a ausência de lead significar algo. */
  cliquesMinimosParaLead: 50,
  /** Origens mínimas para a taxa de código perdido dizer alguma coisa. */
  origensMinimas: 20,
  /** Acima desta fração de origens sem anúncio identificado, a atribuição fura. */
  limiteCodigoPerdido: 0.3,
  /** Conversões em dead-letter que caracterizam loop aberto. */
  minConversoesFalhadas: 5,
} as const

/**
 * Gasto do dia muito acima da linha de base.
 *
 * ⚠️ Só olha para CIMA. Gasto que despenca é `veiculacao_parada`, com outra causa
 * e outra ação — juntar os dois num alerta faria o operador procurar cartão
 * recusado quando o problema é orçamento disparado, e vice-versa.
 */
export function avaliarGastoAnomalo(
  hojeCentavos: number, baseDiariaCentavos: readonly number[], regras = REGRAS,
): Anomalia | null {
  if (baseDiariaCentavos.length < regras.diasBase) return null
  if (hojeCentavos < regras.gastoMinimoRelevante) return null

  const media = baseDiariaCentavos.reduce((s, v) => s + v, 0) / baseDiariaCentavos.length
  if (media <= 0) return null
  if (hojeCentavos < media * regras.fatorGasto) return null

  return {
    tipo: 'midia_gasto_anomalo',
    severidade: 'critico',
    mensagem: `Gasto de hoje (${reais(hojeCentavos)}) está ${(hojeCentavos / media).toFixed(1)}× a `
      + `média dos últimos ${baseDiariaCentavos.length} dias (${reais(media)}).`,
  }
}

/**
 * Veiculação que gastava e parou.
 *
 * ⚠️ Causas típicas: cartão recusado, conta suspensa, reprovação de política. É
 * perda de receita silenciosa — ninguém reclama de anúncio que parou, porque não
 * aparece erro em lugar nenhum.
 */
export function avaliarVeiculacaoParada(
  hojeCentavos: number, baseDiariaCentavos: readonly number[], regras = REGRAS,
): Anomalia | null {
  if (baseDiariaCentavos.length < regras.diasBase) return null
  if (hojeCentavos > 0) return null

  const diasComGasto = baseDiariaCentavos.filter((v) => v > 0).length
  // ⚠️ Exige histórico CONSISTENTE: conta que gasta um dia sim, outro não, não
  //    está "parada" — está no ritmo dela.
  if (diasComGasto < baseDiariaCentavos.length) return null

  const media = baseDiariaCentavos.reduce((s, v) => s + v, 0) / baseDiariaCentavos.length
  if (media < regras.gastoMinimoRelevante) return null

  return {
    tipo: 'midia_veiculacao_parada',
    severidade: 'critico',
    mensagem: `Nenhum gasto hoje, depois de ${baseDiariaCentavos.length} dias seguidos gastando `
      + `(média ${reais(media)}/dia). Verifique forma de pagamento, política e estado da conta.`,
  }
}

/**
 * ⚠️ **O PIOR sinal, e o motivo de o vigia existir.**
 *
 * Há cliques e há gasto, mas nenhum lead entrou. O painel da plataforma continua
 * BONITO — impressões, cliques, CTR, tudo normal — enquanto o dinheiro sai e nada
 * chega. Sem esta regra, a descoberta viria pelo cliente perguntando por que não
 * recebeu ninguém.
 *
 * Causas típicas: landing page fora do ar, link `wa.me` errado, webhook quebrado.
 */
export function avaliarLeadsSumiram(
  cliques: number, leads: number, gastoCentavos: number, regras = REGRAS,
): Anomalia | null {
  if (cliques < regras.cliquesMinimosParaLead) return null
  if (leads > 0) return null
  if (gastoCentavos < regras.gastoMinimoRelevante) return null

  return {
    tipo: 'midia_leads_sumiram',
    severidade: 'critico',
    mensagem: `${cliques} cliques e ${reais(gastoCentavos)} gastos, e NENHUM lead entrou. `
      + `Verifique a landing page, o link do WhatsApp e o webhook.`,
  }
}

/**
 * Taxa de origem sem anúncio identificado.
 *
 * ⚠️ **É A métrica de saúde da atribuição** (AMK-017): sem CTWA, o vínculo
 * anúncio ↔ lead depende de um código que o lead pode apagar. Quando essa taxa
 * sobe, o ROAS fura em SILÊNCIO — os leads continuam entrando, as vendas
 * continuam acontecendo, e o crédito simplesmente não chega ao anúncio.
 */
export function avaliarCodigoPerdido(
  total: number, semAnuncio: number, regras = REGRAS,
): Anomalia | null {
  if (total < regras.origensMinimas) return null
  const taxa = semAnuncio / total
  if (taxa < regras.limiteCodigoPerdido) return null

  return {
    tipo: 'midia_codigo_perdido',
    severidade: 'aviso',
    mensagem: `${Math.round(taxa * 100)}% dos leads (${semAnuncio} de ${total}) entraram sem anúncio `
      + `identificado. A atribuição está furando — confira o código no texto do link wa.me.`,
  }
}

/**
 * Conversões que esgotaram as tentativas.
 *
 * ⚠️ Loop aberto: a venda aconteceu, mas a plataforma nunca soube. Ela volta a
 * otimizar por lead barato sem que nada pareça errado deste lado.
 */
export function avaliarConversoesFalhando(
  falhadas: number, regras = REGRAS,
): Anomalia | null {
  if (falhadas < regras.minConversoesFalhadas) return null
  return {
    tipo: 'midia_conversoes_falhando',
    severidade: 'critico',
    mensagem: `${falhadas} conversões não foram entregues à plataforma. O loop está aberto: `
      + `a venda aconteceu e o algoritmo não soube.`,
  }
}

const reais = (centavos: number): string =>
  (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

/**
 * Abre ou resolve um alerta, seguindo a disciplina de `0031`.
 *
 * ⚠️ O evento no outbox só nasce com o alerta NOVO — o `ON CONFLICT` não devolve
 * linha quando já havia um aberto, e sem essa checagem a tela piscaria a cada
 * varredura.
 */
async function aplicar(
  sql: Sql, tenantId: string, tipo: TipoAlertaMidia, anomalia: Anomalia | null,
): Promise<'aberto' | 'resolvido' | 'nada'> {
  if (anomalia) {
    const nova = await sql<{ id: string }[]>`
      INSERT INTO alerta (tenant_id, id, tipo, severidade, mensagem)
      VALUES (${tenantId}, ${randomUUID()}, ${tipo}, ${anomalia.severidade}, ${anomalia.mensagem})
      ON CONFLICT (tenant_id, tipo) WHERE resolvido_em IS NULL DO NOTHING
      RETURNING id`
    if (nova.length === 0) return 'nada'
    await sql`
      INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id, payload)
      VALUES (${tenantId}, 'alerta.novo', 'tenant', ${tenantId}, '{}'::jsonb)`
    return 'aberto'
  }

  const resolvido = await sql<{ id: string }[]>`
    UPDATE alerta SET resolvido_em = now()
     WHERE tenant_id = ${tenantId} AND tipo = ${tipo} AND resolvido_em IS NULL
    RETURNING id`
  return resolvido.length > 0 ? 'resolvido' : 'nada'
}

export interface ResumoVigia {
  readonly abertos: number
  readonly resolvidos: number
}

/**
 * Uma passada do vigia num tenant. Roda como DONO, com `tenant_id` explícito.
 *
 * ⚠️ Compara HOJE contra a base dos dias anteriores — nunca inclui hoje na base,
 * senão o próprio pico que se quer detectar entraria na média e a diluiria.
 */
export async function vigiarTenant(sql: Sql, tenantId: string, agora: Date): Promise<ResumoVigia> {
  const hoje = agora.toISOString().slice(0, 10)

  const [dia] = await sql<{ gasto: string; cliques: number }[]>`
    SELECT coalesce(sum(custo_centavos), 0)::text AS gasto,
           coalesce(sum(cliques), 0)::int         AS cliques
      FROM midia_metrica_dia
     WHERE tenant_id = ${tenantId} AND dia = ${hoje}::date`

  const base = await sql<{ gasto: string }[]>`
    SELECT coalesce(sum(custo_centavos), 0)::text AS gasto
      FROM midia_metrica_dia
     WHERE tenant_id = ${tenantId}
       AND dia >= ${hoje}::date - ${REGRAS.diasBase}::int
       AND dia <  ${hoje}::date
     GROUP BY dia ORDER BY dia`

  const [leadsHoje] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM midia_lead_origem
     WHERE tenant_id = ${tenantId} AND capturado_em >= ${hoje}::date`

  const [origens] = await sql<{ total: number; sem_anuncio: number }[]>`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE anuncio_id IS NULL)::int AS sem_anuncio
      FROM midia_lead_origem
     WHERE tenant_id = ${tenantId} AND capturado_em >= ${hoje}::date - ${REGRAS.diasBase}::int`

  const [conv] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM midia_conversao
     WHERE tenant_id = ${tenantId} AND estado = 'falhou'
       AND criado_em >= ${hoje}::date - ${REGRAS.diasBase}::int`

  const gastoHoje = Number(dia?.gasto ?? 0)
  const serieBase = base.map((b) => Number(b.gasto))

  const resultados = await Promise.all([
    aplicar(sql, tenantId, 'midia_gasto_anomalo', avaliarGastoAnomalo(gastoHoje, serieBase)),
    aplicar(sql, tenantId, 'midia_veiculacao_parada', avaliarVeiculacaoParada(gastoHoje, serieBase)),
    aplicar(sql, tenantId, 'midia_leads_sumiram',
      avaliarLeadsSumiram(dia?.cliques ?? 0, leadsHoje?.n ?? 0, gastoHoje)),
    aplicar(sql, tenantId, 'midia_codigo_perdido',
      avaliarCodigoPerdido(origens?.total ?? 0, origens?.sem_anuncio ?? 0)),
    aplicar(sql, tenantId, 'midia_conversoes_falhando', avaliarConversoesFalhando(conv?.n ?? 0)),
  ])

  return {
    abertos: resultados.filter((r) => r === 'aberto').length,
    resolvidos: resultados.filter((r) => r === 'resolvido').length,
  }
}

/** Varredura de todos os tenants com conta de mídia, guardada por advisory lock. */
export async function vigiarTodos(sql: Sql, agora: Date): Promise<ResumoVigia> {
  const [trava] = await sql<{ ok: boolean }[]>`
    SELECT pg_try_advisory_lock(hashtext('midia_vigia')) AS ok`
  if (!trava?.ok) return { abertos: 0, resolvidos: 0 }

  try {
    const tenants = await sql<{ tenant_id: string }[]>`
      SELECT DISTINCT tenant_id FROM midia_conta WHERE ativo`
    const total = { abertos: 0, resolvidos: 0 }
    for (const { tenant_id } of tenants) {
      const r = await vigiarTenant(sql, tenant_id, agora)
      total.abertos += r.abertos
      total.resolvidos += r.resolvidos
    }
    return total
  } finally {
    await sql`SELECT pg_advisory_unlock(hashtext('midia_vigia'))`
  }
}
