import type { Sql } from '../../db/index.js'
import { calcularRoas } from '@geracrm/shared'

/**
 * RESUMO DIÁRIO DA MÍDIA (AQ-08) — o relatório que o cliente não tinha.
 *
 * ⚠️ **A geração e a ENTREGA são separadas de propósito.** Montar o texto é
 * trabalho de domínio, testável sem rede; entregar é decisão de canal ainda em
 * aberto — e uma decisão com custo real:
 *
 * mandar relatório interno pelo canal não-oficial mistura tráfego operacional com
 * tráfego de atendimento **no mesmo número**, e conta contra o teto de aquecimento
 * da frota (`0037`). Pode ser que o certo seja número dedicado, e-mail, ou webhook.
 *
 * Enquanto isso não se decide, o resumo é montado e a entrega é injetada. Assim a
 * escolha do canal não trava o que já dá para construir — e trocá-la depois é
 * substituir uma função, não reescrever o relatório.
 */

export interface LinhaResumo {
  readonly rotulo: string
  readonly valor: string
  /** Comparação com o dia anterior, quando faz sentido. */
  readonly variacao?: string
}

export interface ResumoDiario {
  readonly tenantId: string
  readonly dia: string
  readonly temDado: boolean
  readonly linhas: readonly LinhaResumo[]
  /** ⚠️ Alertas abertos entram no MESMO resumo — ver `montarTexto`. */
  readonly alertas: readonly string[]
  readonly texto: string
}

/** Quem entrega. Injetada, para o canal não travar a geração. */
export type EntregarResumo = (r: ResumoDiario) => Promise<void>

const reais = (c: number): string =>
  (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

/**
 * Variação percentual em texto. `null` quando não há base — ⚠️ e "sem base" é
 * diferente de "0%": no primeiro dia, exibir 0% inventaria uma estabilidade que
 * ninguém observou.
 */
export function variacao(hoje: number, ontem: number): string | null {
  if (ontem <= 0) return null
  const pct = Math.round(((hoje - ontem) / ontem) * 100)
  if (pct === 0) return 'estável'
  return `${pct > 0 ? '+' : ''}${pct}%`
}

export interface NumerosDoDia {
  readonly custoCentavos: number
  readonly cliques: number
  readonly leads: number
  readonly leadsQualificados: number
  readonly pedidosCentavos: number
  readonly custoOntemCentavos: number
  readonly leadsOntem: number
}

/**
 * Monta o texto do resumo. **Puro** — nenhuma consulta, nenhuma rede.
 *
 * ⚠️ **Os alertas vêm PRIMEIRO, antes dos números.** Um resumo que abre com
 * "gastamos R$ 340" e enterra "nenhum lead entrou hoje" no fim é lido como boa
 * notícia. O que exige ação vai no topo, ou não é lido.
 */
export function montarTexto(
  dia: string, n: NumerosDoDia, alertas: readonly string[],
): { texto: string; linhas: LinhaResumo[] } {
  const linhas: LinhaResumo[] = []

  const varCusto = variacao(n.custoCentavos, n.custoOntemCentavos)
  linhas.push({
    rotulo: 'Investido', valor: reais(n.custoCentavos),
    ...(varCusto ? { variacao: varCusto } : {}),
  })

  const varLeads = variacao(n.leads, n.leadsOntem)
  linhas.push({
    rotulo: 'Leads', valor: String(n.leads),
    ...(varLeads ? { variacao: varLeads } : {}),
  })

  // ⚠️ Custo por lead com zero leads é INDEFINIDO, não zero. Exibir "R$ 0,00"
  //    faria o pior dia parecer o melhor — mesma regra da tela.
  linhas.push({
    rotulo: 'Custo por lead',
    valor: n.leads > 0 ? reais(n.custoCentavos / n.leads) : '—',
  })

  linhas.push({ rotulo: 'Qualificados', valor: String(n.leadsQualificados) })

  if (n.pedidosCentavos > 0) {
    linhas.push({ rotulo: 'Receita atribuída', valor: reais(n.pedidosCentavos) })
    const roas = calcularRoas(n.pedidosCentavos, n.custoCentavos)
    // ⚠️ ROAS aqui SEMPRE com o rótulo do modelo ao lado (AMK-009). Número de
    //    atribuição solto é a promessa que o produto não sustenta.
    if (roas !== null) {
      linhas.push({ rotulo: 'ROAS (último toque, 14d)', valor: `${roas.toFixed(1)}×` })
    }
  }

  const cabecalho = `📊 Mídia · ${dia}`
  const corpoAlertas = alertas.length > 0
    ? `\n⚠️ ${alertas.length === 1 ? 'Atenção' : `${alertas.length} pontos de atenção`}:\n`
      + alertas.map((a) => `• ${a}`).join('\n') + '\n'
    : ''
  const corpoNumeros = linhas
    .map((l) => `${l.rotulo}: ${l.valor}${l.variacao ? ` (${l.variacao})` : ''}`)
    .join('\n')

  return { texto: `${cabecalho}\n${corpoAlertas}\n${corpoNumeros}`, linhas }
}

/** Monta o resumo de um tenant a partir do banco. Não entrega — só monta. */
export async function montarResumo(sql: Sql, tenantId: string, agora: Date): Promise<ResumoDiario> {
  const dia = agora.toISOString().slice(0, 10)

  const [m] = await sql<{ custo: string; cliques: number; ontem: string }[]>`
    SELECT coalesce(sum(custo_centavos) FILTER (WHERE dia = ${dia}::date), 0)::text     AS custo,
           coalesce(sum(cliques)        FILTER (WHERE dia = ${dia}::date), 0)::int      AS cliques,
           coalesce(sum(custo_centavos) FILTER (WHERE dia = ${dia}::date - 1), 0)::text AS ontem
      FROM midia_metrica_dia
     WHERE tenant_id = ${tenantId} AND dia >= ${dia}::date - 1 AND dia <= ${dia}::date`

  const [l] = await sql<{ hoje: number; ontem: number; qualificados: number }[]>`
    SELECT count(*) FILTER (WHERE o.capturado_em >= ${dia}::date)::int AS hoje,
           count(*) FILTER (WHERE o.capturado_em >= ${dia}::date - 1
                              AND o.capturado_em <  ${dia}::date)::int AS ontem,
           count(*) FILTER (WHERE o.capturado_em >= ${dia}::date
                              AND c.qualificado IS TRUE)::int          AS qualificados
      FROM midia_lead_origem o
      JOIN contato c ON c.tenant_id = o.tenant_id AND c.id = o.contato_id
     WHERE o.tenant_id = ${tenantId} AND o.capturado_em >= ${dia}::date - 1`

  // Receita do dia de contatos que vieram de mídia. ⚠️ Modelo declarado no rótulo.
  const [r] = await sql<{ receita: string }[]>`
    SELECT coalesce(sum(v.valor_centavos), 0)::text AS receita
      FROM venda v
     WHERE v.tenant_id = ${tenantId}
       AND v.cancelada_em IS NULL
       AND v.ocorrida_em >= ${dia}::date AND v.ocorrida_em < ${dia}::date + 1
       AND EXISTS (SELECT 1 FROM midia_lead_origem o
                    WHERE o.tenant_id = v.tenant_id AND o.contato_id = v.contato_id
                      AND o.capturado_em <= v.ocorrida_em
                      AND o.capturado_em >= v.ocorrida_em - interval '14 days')`

  const abertos = await sql<{ mensagem: string }[]>`
    SELECT mensagem FROM alerta
     WHERE tenant_id = ${tenantId} AND resolvido_em IS NULL AND tipo LIKE 'midia_%'
     ORDER BY severidade DESC, criado_em`

  const numeros: NumerosDoDia = {
    custoCentavos: Number(m?.custo ?? 0),
    cliques: m?.cliques ?? 0,
    leads: l?.hoje ?? 0,
    leadsQualificados: l?.qualificados ?? 0,
    pedidosCentavos: Number(r?.receita ?? 0),
    custoOntemCentavos: Number(m?.ontem ?? 0),
    leadsOntem: l?.ontem ?? 0,
  }
  const alertas = abertos.map((a) => a.mensagem)
  const { texto, linhas } = montarTexto(dia, numeros, alertas)

  // ⚠️ "Sem dado" é diferente de "tudo zero": sem gasto, sem lead e sem alerta,
  //    não há o que relatar — e mandar um resumo vazio todo dia é o caminho mais
  //    curto para o cliente parar de ler os que importam.
  const temDado = numeros.custoCentavos > 0 || numeros.leads > 0 || alertas.length > 0

  return { tenantId, dia, temDado, linhas, alertas, texto }
}

export interface ResultadoResumos {
  readonly montados: number
  readonly entregues: number
  readonly semDado: number
}

/**
 * Monta e entrega o resumo de cada tenant com conta de mídia.
 *
 * ⚠️ Sem `entregar`, apenas MONTA — útil para inspecionar o texto sem mandar nada
 * a ninguém enquanto o canal não está decidido.
 */
export async function resumirTodos(
  sql: Sql, agora: Date, entregar?: EntregarResumo,
): Promise<ResultadoResumos> {
  const tenants = await sql<{ tenant_id: string }[]>`
    SELECT DISTINCT tenant_id FROM midia_conta WHERE ativo`

  let montados = 0, entregues = 0, semDado = 0
  for (const { tenant_id } of tenants) {
    const resumo = await montarResumo(sql, tenant_id, agora)
    montados++
    if (!resumo.temDado) { semDado++; continue }
    if (entregar) { await entregar(resumo); entregues++ }
  }
  return { montados, entregues, semDado }
}
