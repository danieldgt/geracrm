import type { Sql } from '../../db/index.js'
import type { PeriodoResolvido } from './periodo-relatorio.js'
import { condicaoContato, condicaoOportunidade, condicaoTarefa, type Escopo } from './escopo.js'
import { contatosPorDimensao, taxaDe } from './rotas-relatorios.js'
import { ticketMedio } from './relatorios-vendas.js'

/**
 * RELATÓRIOS DE GESTÃO (raia E2): tempo de conversão, vendedores e operacional.
 * Todos: período no fuso do tenant (`[desde, ate)`), escopo da D3 e só LEITURA.
 *
 * Regra de conversão (a do E1, um número só): convertido = contato com pedido EFETIVADO no período.
 */

// ── Tempo de conversão ──────────────────────────────────────────────────────────────────────────

export const FAIXAS_CONVERSAO = ['0-7', '8-15', '16-30', '31-60', '61-90', '90+'] as const
export type FaixaConversao = (typeof FAIXAS_CONVERSAO)[number]

/** Faixa de uma duração em DIAS INTEIROS: 0-7, 8-15, 16-30, 31-60, 61-90, 90+ (fronteiras inclusivas). */
export function faixaDeDias(dias: number): FaixaConversao {
  if (dias <= 7) return '0-7'
  if (dias <= 15) return '8-15'
  if (dias <= 30) return '16-30'
  if (dias <= 60) return '31-60'
  if (dias <= 90) return '61-90'
  return '90+'
}

export interface ResumoConversao {
  readonly contatos: number
  readonly mediaDias: number | null
  readonly maisRapidaDias: number | null
  readonly maisLentaDias: number | null
}
export interface FaixaConversaoItem { readonly faixa: FaixaConversao; readonly contatos: number; readonly percentual: number }
export interface VendedorConversao extends ResumoConversao { readonly chave: string; readonly rotulo: string }

/** Média com 1 casa (null sem contatos). */
export function mediaDe(somaDias: number, contatos: number): number | null {
  return contatos > 0 ? Math.round((somaDias / contatos) * 10) / 10 : null
}

interface LinhaFaixa { faixa: FaixaConversao; contatos: number; soma: string; minimo: number; maximo: number }
interface LinhaVendedorConv { chave: string; rotulo: string; contatos: number; soma: string; minimo: number; maximo: number }

/**
 * Conversão = o PRIMEIRO pedido efetivado do contato (de todos os tempos) cair no período; os dias vão do
 * `criado_em` do contato até esse pedido (dias inteiros, mínimo 0). Recompra não conta: só a 1ª compra.
 * Contatos ativos, sem simulação, dentro do escopo.
 */
function conversoes(tx: Sql, p: PeriodoResolvido, escopo: Escopo) {
  return tx`
    SELECT c.id, c.criado_em, pr.em,
           greatest(0, floor(extract(epoch FROM (pr.em - c.criado_em)) / 86400))::int AS dias,
           ca.usuario_id, u.nome AS vendedor
      FROM (SELECT pd.contato_id, min(pd.efetivado_em) AS em
              FROM pedido pd
             WHERE pd.tenant_id = tenant_atual() AND pd.estado = 'efetivado' AND pd.contato_id IS NOT NULL
               AND pd.contato_id IN (SELECT x.contato_id FROM pedido x
                                      WHERE x.tenant_id = tenant_atual() AND x.estado = 'efetivado'
                                        AND x.efetivado_em >= ${p.desde} AND x.efetivado_em < ${p.ate}
                                        AND x.contato_id IS NOT NULL)
             GROUP BY pd.contato_id
            HAVING min(pd.efetivado_em) >= ${p.desde} AND min(pd.efetivado_em) < ${p.ate}) pr
      JOIN contato c ON c.tenant_id = tenant_atual() AND c.id = pr.contato_id
      LEFT JOIN carteira_atribuicao ca ON ca.tenant_id = c.tenant_id AND ca.contato_id = c.id AND ca.ate IS NULL
      LEFT JOIN usuario u ON u.tenant_id = ca.tenant_id AND u.id = ca.usuario_id
     WHERE c.ativo AND coalesce(c.origem_carga, '') <> 'simulacao'
       AND ${condicaoContato(tx, escopo, 'c')}`
}

export async function tempoDeConversao(tx: Sql, p: PeriodoResolvido, escopo: Escopo): Promise<{
  resumo: ResumoConversao; faixas: FaixaConversaoItem[]; porVendedor: VendedorConversao[]; porVendedorTruncado: boolean
}> {
  const faixaSql = tx`CASE WHEN dias <= 7 THEN '0-7' WHEN dias <= 15 THEN '8-15' WHEN dias <= 30 THEN '16-30'
                           WHEN dias <= 60 THEN '31-60' WHEN dias <= 90 THEN '61-90' ELSE '90+' END`
  const porFaixa = await tx<LinhaFaixa[]>`
    WITH conv AS (${conversoes(tx, p, escopo)})
    SELECT ${faixaSql} AS faixa, count(*)::int AS contatos, sum(dias)::text AS soma,
           min(dias)::int AS minimo, max(dias)::int AS maximo
      FROM conv GROUP BY 1`
  const porVend = await tx<LinhaVendedorConv[]>`
    WITH conv AS (${conversoes(tx, p, escopo)})
    SELECT coalesce(usuario_id::text, 'sem-vendedor') AS chave, coalesce(min(vendedor), 'Sem vendedor') AS rotulo,
           count(*)::int AS contatos, sum(dias)::text AS soma, min(dias)::int AS minimo, max(dias)::int AS maximo
      FROM conv GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 101`

  const total = porFaixa.reduce((s, l) => s + l.contatos, 0)
  const soma = porFaixa.reduce((s, l) => s + Number(l.soma), 0)
  const mapa = new Map(porFaixa.map((l) => [l.faixa, l]))
  const truncado = porVend.length > 100
  return {
    resumo: {
      contatos: total, mediaDias: mediaDe(soma, total),
      maisRapidaDias: total > 0 ? Math.min(...porFaixa.map((l) => l.minimo)) : null,
      maisLentaDias: total > 0 ? Math.max(...porFaixa.map((l) => l.maximo)) : null,
    },
    faixas: FAIXAS_CONVERSAO.map((faixa) => {
      const n = mapa.get(faixa)?.contatos ?? 0
      return { faixa, contatos: n, percentual: total > 0 ? Math.round((n / total) * 10_000) / 10_000 : 0 }
    }),
    porVendedor: (truncado ? porVend.slice(0, 100) : porVend).map((l) => ({
      chave: l.chave, rotulo: l.rotulo, contatos: l.contatos, mediaDias: mediaDe(Number(l.soma), l.contatos),
      maisRapidaDias: l.minimo, maisLentaDias: l.maximo,
    })),
    porVendedorTruncado: truncado,
  }
}

// ── Vendedores ──────────────────────────────────────────────────────────────────────────────────

export const TOP_VENDEDORES = 10

export interface VendedorDesempenho {
  readonly usuarioId: string
  readonly nome: string
  readonly contatosNovos: number
  readonly tarefasConcluidas: number
  readonly conversoes: number
  readonly taxa: number | null
  readonly pedidos: number
  readonly valorCentavos: number
  readonly ticketMedioCentavos: number
}

interface LinhaVendedor {
  id: string; nome: string; contatos: number; tarefas: number; conv: number; pedidos: number; valor: string
}

/**
 * Desempenho por vendedor no período — top 10 por valor (depois conversões):
 *   contatosNovos     contatos CRIADOS no período que estão na carteira vigente da pessoa;
 *   conversoes/taxa/valor/pedidos   a COORTE do E1 (desses contatos, os com pedido efetivado no período);
 *   tarefasConcluidas tarefas concluídas no período por quem concluiu (ou o responsável, se não gravou quem);
 *   ticketMedio       valor / pedidos.
 * `totalVendedores` conta quem aparece no recorte, antes do corte do top 10.
 */
export async function desempenhoVendedores(
  tx: Sql, p: PeriodoResolvido, escopo: Escopo,
): Promise<{ itens: VendedorDesempenho[]; totalVendedores: number }> {
  const linhas = await tx<LinhaVendedor[]>`
    WITH coorte AS (
      SELECT c.id, ca.usuario_id
        FROM contato c
        JOIN carteira_atribuicao ca ON ca.tenant_id = c.tenant_id AND ca.contato_id = c.id
                                   AND ca.ate IS NULL AND ca.usuario_id IS NOT NULL
       WHERE c.tenant_id = tenant_atual() AND c.ativo AND coalesce(c.origem_carga, '') <> 'simulacao'
         AND c.criado_em >= ${p.desde} AND c.criado_em < ${p.ate}
         AND ${condicaoContato(tx, escopo, 'c')}
    ), compras AS (
      SELECT pd.contato_id, count(*)::int AS pedidos, sum(pd.total_centavos) AS valor
        FROM pedido pd
       WHERE pd.tenant_id = tenant_atual() AND pd.estado = 'efetivado'
         AND pd.efetivado_em >= ${p.desde} AND pd.efetivado_em < ${p.ate}
         AND pd.contato_id IN (SELECT id FROM coorte)
       GROUP BY pd.contato_id
    ), por_contato AS (
      SELECT k.usuario_id, count(*)::int AS contatos, count(cp.contato_id)::int AS conv,
             coalesce(sum(cp.pedidos), 0)::int AS pedidos, coalesce(sum(cp.valor), 0) AS valor
        FROM coorte k LEFT JOIN compras cp ON cp.contato_id = k.id
       GROUP BY k.usuario_id
    ), por_tarefa AS (
      SELECT coalesce(t.concluida_por, t.responsavel_id) AS usuario_id, count(*)::int AS tarefas
        FROM tarefa t
       WHERE t.tenant_id = tenant_atual() AND t.estado = 'concluida'
         AND t.concluida_em >= ${p.desde} AND t.concluida_em < ${p.ate}
         AND coalesce(t.concluida_por, t.responsavel_id) IS NOT NULL
         AND ${condicaoTarefa(tx, escopo, 't')}
       GROUP BY 1
    )
    SELECT u.id, u.nome, coalesce(pc.contatos, 0) AS contatos, coalesce(pt.tarefas, 0) AS tarefas,
           coalesce(pc.conv, 0) AS conv, coalesce(pc.pedidos, 0) AS pedidos, coalesce(pc.valor, 0)::text AS valor
      FROM usuario u
      LEFT JOIN por_contato pc ON pc.usuario_id = u.id
      LEFT JOIN por_tarefa pt ON pt.usuario_id = u.id
     WHERE u.tenant_id = tenant_atual() AND (pc.usuario_id IS NOT NULL OR pt.usuario_id IS NOT NULL)
     ORDER BY coalesce(pc.valor, 0) DESC, coalesce(pc.conv, 0) DESC, u.nome, u.id`
  const todos = linhas.map((l): VendedorDesempenho => ({
    usuarioId: l.id, nome: l.nome, contatosNovos: l.contatos, tarefasConcluidas: l.tarefas, conversoes: l.conv,
    taxa: taxaDe(l.conv, l.contatos), pedidos: l.pedidos, valorCentavos: Number(l.valor),
    ticketMedioCentavos: ticketMedio(Number(l.valor), l.pedidos),
  }))
  return { itens: todos.slice(0, TOP_VENDEDORES), totalVendedores: todos.length }
}

// ── Operacional ─────────────────────────────────────────────────────────────────────────────────

export const TOP_OPERACIONAL = 5

export interface JanelaMes {
  readonly inicio: string
  readonly fim: string
  readonly contatosNovos: number
  readonly conversoes: number
  readonly valorCentavos: number
}
export interface EtapaFunil { readonly chave: string; readonly rotulo: string; readonly oportunidades: number }
export interface TopItem { readonly chave: string; readonly rotulo: string; readonly total: number }

interface JanelaBruta { inicio: string; fim: string; desde: Date; ate: Date }

/**
 * Mês de referência = o mês do FIM do período (hoje, por padrão). Janela atual = do dia 1 até o `fim`;
 * a anterior = o mês anterior até o MESMO dia do mês (limitado ao último dia dele) — comparação justa,
 * sem pôr um mês fechado contra um mês pela metade. Fronteiras no fuso do tenant.
 */
async function janelasDoMes(tx: Sql, p: PeriodoResolvido): Promise<{ atual: JanelaBruta; anterior: JanelaBruta }> {
  const [j] = await tx<{
    ai: string; af: string; ad: Date; aa: Date; pi: string; pf: string; pd: Date; pa: Date
  }[]>`
    SELECT to_char(x.mi, 'YYYY-MM-DD') AS ai, to_char(x.f, 'YYYY-MM-DD') AS af,
           x.mi::timestamp AT TIME ZONE ${p.fuso}::text AS ad, (x.f + 1)::timestamp AT TIME ZONE ${p.fuso}::text AS aa,
           to_char(x.pi, 'YYYY-MM-DD') AS pi, to_char(x.pf, 'YYYY-MM-DD') AS pf,
           x.pi::timestamp AT TIME ZONE ${p.fuso}::text AS pd, (x.pf + 1)::timestamp AT TIME ZONE ${p.fuso}::text AS pa
      FROM (SELECT m.mi, m.f, (m.mi - interval '1 month')::date AS pi,
                   least(((m.mi - interval '1 month')::date + (m.f - m.mi)), (m.mi - 1)) AS pf
              FROM (SELECT date_trunc('month', ${p.fim}::date)::date AS mi, ${p.fim}::date AS f) m) x`
  return {
    atual: { inicio: j!.ai, fim: j!.af, desde: j!.ad, ate: j!.aa },
    anterior: { inicio: j!.pi, fim: j!.pf, desde: j!.pd, ate: j!.pa },
  }
}

async function cartoesDaJanela(tx: Sql, j: JanelaBruta, fuso: string, escopo: Escopo): Promise<JanelaMes> {
  // 'qualificacao' é domínio fechado: todo contato cai em exatamente um item, então a soma é o total do recorte.
  const { itens } = await contatosPorDimensao(tx, 'qualificacao', { ...j, fuso }, escopo)
  return {
    inicio: j.inicio, fim: j.fim,
    contatosNovos: itens.reduce((s, i) => s + i.contatos, 0),
    conversoes: itens.reduce((s, i) => s + i.convertidos, 0),
    valorCentavos: itens.reduce((s, i) => s + i.valorCentavos, 0),
  }
}

export async function operacional(tx: Sql, p: PeriodoResolvido, escopo: Escopo): Promise<{
  mesAtual: JanelaMes; mesAnterior: JanelaMes; funil: EtapaFunil[]; topOrigens: TopItem[]; topFormularios: TopItem[]
}> {
  const { atual, anterior } = await janelasDoMes(tx, p)
  const mesAtual = await cartoesDaJanela(tx, atual, p.fuso, escopo)
  const mesAnterior = await cartoesDaJanela(tx, anterior, p.fuso, escopo)

  // Funil: FOTO de agora — oportunidades abertas por etapa ativa, na ordem do funil.
  const funil = await tx<{ chave: string; rotulo: string; n: number }[]>`
    SELECT fe.chave, fe.nome AS rotulo, count(o.id)::int AS n
      FROM funil_etapa fe
      LEFT JOIN oportunidade o ON o.tenant_id = fe.tenant_id AND o.etapa_id = fe.id AND o.estado = 'aberta'
                              AND ${condicaoOportunidade(tx, escopo, 'o')}
     WHERE fe.tenant_id = tenant_atual() AND fe.ativo
     GROUP BY fe.id, fe.chave, fe.nome, fe.ordem
     ORDER BY fe.ordem, fe.chave`

  // Top 5 origens: contatos criados na janela atual.
  const origens = await tx<{ chave: string; rotulo: string; n: number }[]>`
    SELECT coalesce(c.origem_id::text, 'sem-origem') AS chave, coalesce(min(o.nome), 'Sem origem') AS rotulo, count(*)::int AS n
      FROM contato c
      LEFT JOIN origem o ON o.tenant_id = c.tenant_id AND o.id = c.origem_id
     WHERE c.tenant_id = tenant_atual() AND c.ativo AND coalesce(c.origem_carga, '') <> 'simulacao'
       AND c.criado_em >= ${atual.desde} AND c.criado_em < ${atual.ate}
       AND ${condicaoContato(tx, escopo, 'c')}
     GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT ${TOP_OPERACIONAL}`

  // Top 5 formulários: respostas na janela atual. Fora do escopo "tudo", só resposta com contato visível.
  const visivel = escopo.tipo === 'tudo' ? tx`true` : tx`(fr.contato_id IS NOT NULL AND ${condicaoContato(tx, escopo, 'c')})`
  const formularios = await tx<{ chave: string; rotulo: string; n: number }[]>`
    SELECT f.id::text AS chave, f.nome AS rotulo, count(*)::int AS n
      FROM formulario_resposta fr
      JOIN formulario f ON f.tenant_id = fr.tenant_id AND f.id = fr.formulario_id
      LEFT JOIN contato c ON c.tenant_id = fr.tenant_id AND c.id = fr.contato_id
     WHERE fr.tenant_id = tenant_atual()
       AND fr.criado_em >= ${atual.desde} AND fr.criado_em < ${atual.ate}
       AND ${visivel}
     GROUP BY f.id, f.nome ORDER BY count(*) DESC, f.nome LIMIT ${TOP_OPERACIONAL}`

  return {
    mesAtual, mesAnterior,
    funil: funil.map((l) => ({ chave: l.chave, rotulo: l.rotulo, oportunidades: l.n })),
    topOrigens: origens.map((l) => ({ chave: l.chave, rotulo: l.rotulo, total: l.n })),
    topFormularios: formularios.map((l) => ({ chave: l.chave, rotulo: l.rotulo, total: l.n })),
  }
}
