import { custoCampanhaCentavos, custoPorVenda } from '@geracrm/shared'
import type { Sql } from '../../db/index.js'
import { ehCategoria, precosEfetivos } from '../atendimento/consumo.js'
import { roiCampanha, type Roi } from './campanha-analise.js'

/**
 * RELATÓRIO DA CAMPANHA V2 (F1, #77): o funil até a venda.
 *
 *   elegíveis → enviadas → entregues → lidas → responderam → pedidos (EXATA)
 *                                                           ↘ vendas na janela (ESTIMADA)
 *
 * ⚠️ Cada degrau conta pelo PRÓPRIO marco (`entregue_em`, `lido_em`, `respondeu_em`), e
 *    um marco posterior implica os anteriores (lida sem "entregue" porque o webhook chegou
 *    fora de ordem continua entregue). Assim o funil nunca "sobe" de um degrau para o outro.
 * ⚠️ Pedido (exata) e venda na janela (estimada) vêm SEPARADOS — somar infla o número
 *    (skill funil-de-vendas). O custo por venda sai das duas formas, rotuladas.
 * ⚠️ Custo: mensagens ENVIADAS SEM FALHA devolvida pela Meta × preço da categoria do template (preços da F2, padrão da
 *    API quando o tenant não definiu) — a mesma regra da tela de Consumo, para os dois
 *    números baterem. Número não oficial não tem tarifa da Meta: custo 0.
 */

export interface RelatorioCampanha {
  readonly campanhaId: string
  readonly estado: string
  readonly pausaMotivo: string | null
  readonly funil: {
    readonly elegiveis: number
    readonly enviadas: number
    readonly entregues: number
    readonly lidas: number
    readonly responderam: number
    readonly pedidos: number
    readonly vendasEstimadas: number
  }
  readonly progresso: { readonly pendentes: number; readonly enviando: number; readonly processados: number; readonly percentual: number }
  readonly excluidos: Readonly<Record<string, number>>
  readonly optOuts: number
  readonly falhas: number
  readonly falhasPorCodigo: readonly { codigo: string; n: number }[]
  readonly custo: {
    readonly categoria: string | null
    /** Mensagens que entram no custo: enviadas sem falha devolvida pela Meta. */
    readonly mensagensCobradas: number
    readonly precoUnitarioCentavos: number
    readonly totalCentavos: number
    readonly porPedidoCentavos: number | null
    readonly porVendaEstimadaCentavos: number | null
  }
  readonly roi: Roi
}

export async function relatorioCampanha(tx: Sql, campanhaId: string): Promise<RelatorioCampanha | null> {
  const [c] = await tx<{ estado: string; pausa_motivo: string | null; categoria: string | null; tipo_canal: string | null }[]>`
    SELECT k.estado, k.pausa_motivo, t.categoria, cc.tipo AS tipo_canal
      FROM campanha k
      LEFT JOIN template t ON t.tenant_id = k.tenant_id AND t.id = k.template_id
      LEFT JOIN canal_conectado cc ON cc.tenant_id = k.tenant_id AND cc.id = k.canal_id
     WHERE k.tenant_id = tenant_atual() AND k.id = ${campanhaId}`
  if (!c) return null

  const [f] = await tx<{
    elegiveis: number; enviadas: number; entregues: number; lidas: number; responderam: number
    pendentes: number; enviando: number; falhas: number; optouts: number; cobradas: number
  }[]>`
    SELECT count(*) FILTER (WHERE estado <> 'excluida')::int AS elegiveis,
           count(*) FILTER (WHERE enviado_em IS NOT NULL)::int AS enviadas,
           count(*) FILTER (WHERE enviado_em IS NOT NULL
                              AND coalesce(entregue_em, lido_em, respondeu_em) IS NOT NULL)::int AS entregues,
           count(*) FILTER (WHERE enviado_em IS NOT NULL AND coalesce(lido_em, respondeu_em) IS NOT NULL)::int AS lidas,
           count(*) FILTER (WHERE respondeu_em IS NOT NULL)::int AS responderam,
           count(*) FILTER (WHERE estado = 'pendente')::int AS pendentes,
           count(*) FILTER (WHERE estado = 'enviando')::int AS enviando,
           count(*) FILTER (WHERE estado = 'falhou')::int AS falhas,
           count(*) FILTER (WHERE estado = 'optout')::int AS optouts,
           -- Cobradas: saíram e a Meta não devolveu falha (failed não é cobrado).
           count(*) FILTER (WHERE enviado_em IS NOT NULL AND estado <> 'falhou')::int AS cobradas
      FROM campanha_destinatario
     WHERE tenant_id = tenant_atual() AND campanha_id = ${campanhaId}`
  const excl = await tx<{ motivo: string; n: number }[]>`
    SELECT motivo_exclusao AS motivo, count(*)::int AS n FROM campanha_destinatario
     WHERE tenant_id = tenant_atual() AND campanha_id = ${campanhaId} AND estado = 'excluida'
     GROUP BY 1 ORDER BY 2 DESC`
  const codigos = await tx<{ codigo: string; n: number }[]>`
    SELECT coalesce(erro_codigo, 'desconhecido') AS codigo, count(*)::int AS n FROM campanha_destinatario
     WHERE tenant_id = tenant_atual() AND campanha_id = ${campanhaId} AND estado = 'falhou'
     GROUP BY 1 ORDER BY 2 DESC LIMIT 10`

  const roi = (await roiCampanha(tx, campanhaId))!
  const oficial = c.tipo_canal === 'whatsapp_oficial'
  const categoria = oficial ? (c.categoria ?? 'MARKETING').toLowerCase() : null
  let preco = 0
  if (categoria && ehCategoria(categoria)) {
    const linhas = await tx<{ categoria: string; centavos: number }[]>`
      SELECT categoria, centavos_por_mensagem AS centavos FROM preco_whatsapp WHERE tenant_id = tenant_atual()`
    preco = precosEfetivos(linhas)[categoria]
  }

  const z = f ?? { elegiveis: 0, enviadas: 0, entregues: 0, lidas: 0, responderam: 0, pendentes: 0, enviando: 0, falhas: 0, optouts: 0, cobradas: 0 }
  const total = custoCampanhaCentavos(z.cobradas, preco)
  const processados = z.elegiveis - z.pendentes - z.enviando
  return {
    campanhaId, estado: c.estado, pausaMotivo: c.pausa_motivo,
    funil: {
      elegiveis: z.elegiveis, enviadas: z.enviadas, entregues: z.entregues, lidas: z.lidas, responderam: z.responderam,
      pedidos: roi.exata.pedidos, vendasEstimadas: roi.estimada.vendas,
    },
    progresso: {
      pendentes: z.pendentes, enviando: z.enviando, processados,
      percentual: z.elegiveis > 0 ? Math.floor((processados * 100) / z.elegiveis) : 0,
    },
    excluidos: Object.fromEntries(excl.map((e) => [e.motivo, e.n])),
    optOuts: z.optouts,
    falhas: z.falhas,
    falhasPorCodigo: codigos,
    custo: {
      categoria, mensagensCobradas: z.cobradas, precoUnitarioCentavos: preco, totalCentavos: total,
      porPedidoCentavos: custoPorVenda(total, roi.exata.pedidos),
      porVendaEstimadaCentavos: custoPorVenda(total, roi.estimada.vendas),
    },
    roi,
  }
}
