import type { Sql } from '../../db/index.js'
import type { PeriodoResolvido } from './periodo-relatorio.js'
import { condicaoPedido, type Escopo } from './escopo.js'

/**
 * RELATÓRIO "VENDAS POR DIMENSÃO" (raia E2).
 *
 *   GET /v1/relatorios/vendas-por/:dimensao?inicio=yyyy-mm-dd&fim=yyyy-mm-dd
 *
 * FONTE DE VERDADE DE "VENDA" AQUI: o PEDIDO EFETIVADO (`pedido.estado = 'efetivado'`, data em
 * `efetivado_em`, fuso do tenant) — a mesma régua do card "conversão" do Início e do relatório
 * "contatos por dimensão" (E1): um número só, em todo lugar. A tabela `venda` (ERP, usada pelo RFV
 * e pelo BI de 7/30/90 dias) NÃO entra: o pedido efetivado vira `venda` quando o ERP o fatura,
 * e somar as duas fontes contaria a mesma compra duas vezes. Compra feita direto no PDV do ERP
 * (sem pedido no CRM) fica de fora de propósito — este relatório mede o que o CRM vendeu.
 *
 * Contatos de simulação ficam fora (mesma regra do E1). Valor em centavos inteiros.
 * ESCOPO (D3): só os pedidos que `condicaoPedido` deixa quem pede enxergar.
 *
 * `percentual` = fatia do valor do grupo no valor total (0..1, 4 casas). Em `produto` a base é a
 * soma dos itens (quantidade x preço da linha), porque um pedido tem vários produtos; nas demais
 * a soma dos grupos é o total do período. `pedidos` em `produto` = pedidos que contêm o produto.
 *
 * Limites: 100 grupos (os de maior valor; `truncado` avisa). `dia` sai completo e em ordem
 * cronológica (até 366 dias); `dia-semana` sempre completo (1 = segunda ... 7 = domingo).
 */
export const DIMENSOES_VENDAS = ['dia', 'dia-semana', 'produto', 'cliente', 'origem', 'vendedor', 'canal'] as const
export type DimensaoVendas = (typeof DIMENSOES_VENDAS)[number]
export const LIMITE_GRUPOS_VENDAS = 100

export interface ItemVendas {
  readonly chave: string
  readonly rotulo: string
  readonly pedidos: number
  readonly valorCentavos: number
  readonly ticketMedioCentavos: number
  readonly percentual: number
}
export interface TotaisVendas { readonly pedidos: number; readonly valorCentavos: number; readonly ticketMedioCentavos: number }

export function ehDimensaoVendas(v: string): v is DimensaoVendas {
  return (DIMENSOES_VENDAS as readonly string[]).includes(v)
}

/** Ticket médio em centavos inteiros (0 sem pedidos). */
export function ticketMedio(valorCentavos: number, pedidos: number): number {
  return pedidos > 0 ? Math.round(valorCentavos / pedidos) : 0
}

/** Fatia 0..1 com 4 casas (0 quando o total é zero). */
export function fatia(parte: number, total: number): number {
  return total > 0 ? Math.round((parte / total) * 10_000) / 10_000 : 0
}

/** Todos os dias `yyyy-mm-dd` de `inicio` a `fim` (inclusivos). Datas já validadas (máx. 366 dias). */
export function diasDoPeriodo(inicio: string, fim: string): string[] {
  const out: string[] = []
  for (let ms = Date.parse(`${inicio}T00:00:00Z`); ms <= Date.parse(`${fim}T00:00:00Z`); ms += 86_400_000) {
    out.push(new Date(ms).toISOString().slice(0, 10))
  }
  return out
}

const DIAS_SEMANA: readonly (readonly [string, string])[] = [
  ['1', 'Segunda'], ['2', 'Terça'], ['3', 'Quarta'], ['4', 'Quinta'], ['5', 'Sexta'], ['6', 'Sábado'], ['7', 'Domingo'],
]

interface Linha { chave: string; rotulo: string; pedidos: number; valor: string }

/** Chave e rótulo SQL por dimensão (aliases: pd pedido, c contato, o origem, u vendedor, cc canal). */
function fragmento(tx: Sql, dim: Exclude<DimensaoVendas, 'produto'>, fuso: string) {
  switch (dim) {
    case 'dia': {
      const d = tx`to_char(pd.efetivado_em AT TIME ZONE ${fuso}::text, 'YYYY-MM-DD')`
      return { chave: d, rotulo: tx`''`, ordem: tx`1` }
    }
    case 'dia-semana':
      return { chave: tx`extract(isodow FROM pd.efetivado_em AT TIME ZONE ${fuso}::text)::int::text`, rotulo: tx`''`, ordem: tx`1` }
    case 'cliente':
      return { chave: tx`coalesce(pd.contato_id::text, 'sem-cliente')`, rotulo: tx`coalesce(min(c.nome), 'Sem cliente')`,
        ordem: tx`sum(pd.total_centavos) DESC, 1` }
    case 'origem':
      return { chave: tx`coalesce(c.origem_id::text, 'sem-origem')`, rotulo: tx`coalesce(min(o.nome), 'Sem origem')`,
        ordem: tx`sum(pd.total_centavos) DESC, 1` }
    case 'vendedor':
      return { chave: tx`coalesce(pd.vendedor_id::text, 'sem-vendedor')`, rotulo: tx`coalesce(min(u.nome), 'Sem vendedor')`,
        ordem: tx`sum(pd.total_centavos) DESC, 1` }
    case 'canal':
      // O canal é o da conversa onde o pedido nasceu (ADR-005); pedido sem conversa = "Sem canal".
      return { chave: tx`coalesce(cv.canal_id::text, 'sem-canal')`, rotulo: tx`coalesce(min(cc.nome_amigavel), 'Sem canal')`,
        ordem: tx`sum(pd.total_centavos) DESC, 1` }
  }
}

/** Pedidos efetivados do período, no escopo, sem simulação — com os joins de todas as dimensões. */
function pedidosBase(tx: Sql, p: PeriodoResolvido, escopo: Escopo) {
  return tx`
    FROM pedido pd
    LEFT JOIN contato c ON c.tenant_id = pd.tenant_id AND c.id = pd.contato_id
    LEFT JOIN origem o ON o.tenant_id = c.tenant_id AND o.id = c.origem_id
    LEFT JOIN usuario u ON u.tenant_id = pd.tenant_id AND u.id = pd.vendedor_id
    LEFT JOIN conversa cv ON cv.tenant_id = pd.tenant_id AND cv.id = pd.conversa_id
    LEFT JOIN canal_conectado cc ON cc.tenant_id = cv.tenant_id AND cc.id = cv.canal_id
   WHERE pd.tenant_id = tenant_atual() AND pd.estado = 'efetivado'
     AND pd.efetivado_em >= ${p.desde} AND pd.efetivado_em < ${p.ate}
     AND coalesce(c.origem_carga, '') <> 'simulacao'
     AND ${condicaoPedido(tx, escopo, 'pd')}`
}

/** Vendas do período agrupadas por dimensão + totais. Só LEITURA, sempre filtrada por período. */
export async function vendasPorDimensao(
  tx: Sql, dim: DimensaoVendas, p: PeriodoResolvido, escopo: Escopo,
): Promise<{ itens: ItemVendas[]; totais: TotaisVendas; truncado: boolean }> {
  const base = pedidosBase(tx, p, escopo)
  const [t] = await tx<{ pedidos: number; valor: string }[]>`
    SELECT count(*)::int AS pedidos, coalesce(sum(pd.total_centavos), 0)::text AS valor ${base}`
  const totais: TotaisVendas = {
    pedidos: t?.pedidos ?? 0, valorCentavos: Number(t?.valor ?? 0),
    ticketMedioCentavos: ticketMedio(Number(t?.valor ?? 0), t?.pedidos ?? 0),
  }

  let linhas: Linha[]
  if (dim === 'produto') {
    linhas = await tx<Linha[]>`
      SELECT it.sku_snapshot AS chave, min(it.descricao_snapshot) AS rotulo,
             count(DISTINCT it.pedido_id)::int AS pedidos,
             sum(round(it.quantidade * it.valor_unitario_centavos))::text AS valor
        FROM pedido_item it
       WHERE it.tenant_id = tenant_atual()
         AND it.pedido_id IN (SELECT pd.id ${base})
       GROUP BY it.sku_snapshot
       ORDER BY sum(round(it.quantidade * it.valor_unitario_centavos)) DESC, it.sku_snapshot
       LIMIT ${LIMITE_GRUPOS_VENDAS + 1}`
  } else {
    const f = fragmento(tx, dim, p.fuso)
    const limite = dim === 'dia' ? 366 : dim === 'dia-semana' ? 7 : LIMITE_GRUPOS_VENDAS + 1
    linhas = await tx<Linha[]>`
      SELECT ${f.chave} AS chave, ${f.rotulo} AS rotulo, count(*)::int AS pedidos, sum(pd.total_centavos)::text AS valor
        ${base}
       GROUP BY 1 ORDER BY ${f.ordem} LIMIT ${limite}`
  }

  const fechado = dim === 'dia' || dim === 'dia-semana'
  const truncado = !fechado && linhas.length > LIMITE_GRUPOS_VENDAS
  const cortadas = truncado ? linhas.slice(0, LIMITE_GRUPOS_VENDAS) : linhas
  // Base do percentual: produto = soma dos itens; demais = total de pedidos.
  let baseValor = totais.valorCentavos
  if (dim === 'produto') {
    // Soma de TODOS os itens (sem o corte dos 100), para a fatia não inflar quando há mais produtos.
    const [b] = await tx<{ valor: string }[]>`
      SELECT coalesce(sum(round(it.quantidade * it.valor_unitario_centavos)), 0)::text AS valor
        FROM pedido_item it
       WHERE it.tenant_id = tenant_atual() AND it.pedido_id IN (SELECT pd.id ${base})`
    baseValor = Number(b?.valor ?? 0)
  }
  const montar = (chave: string, rotulo: string, pedidos: number, valor: number): ItemVendas => ({
    chave, rotulo, pedidos, valorCentavos: valor, ticketMedioCentavos: ticketMedio(valor, pedidos), percentual: fatia(valor, baseValor),
  })
  const bruto = new Map(cortadas.map((l) => [l.chave, l]))

  if (dim === 'dia') {
    return {
      truncado: false, totais,
      itens: diasDoPeriodo(p.inicio, p.fim).map((d) => {
        const l = bruto.get(d)
        return montar(d, d, l?.pedidos ?? 0, Number(l?.valor ?? 0))
      }),
    }
  }
  if (dim === 'dia-semana') {
    return {
      truncado: false, totais,
      itens: DIAS_SEMANA.map(([chave, rotulo]) => {
        const l = bruto.get(chave)
        return montar(chave, rotulo, l?.pedidos ?? 0, Number(l?.valor ?? 0))
      }),
    }
  }
  return { truncado, totais, itens: cortadas.map((l) => montar(l.chave, l.rotulo, l.pedidos, Number(l.valor))) }
}
