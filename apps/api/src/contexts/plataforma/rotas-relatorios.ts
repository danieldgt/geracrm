import type { FastifyInstance } from 'fastify'
import { exigirTenant } from '../../plugins/tenant.js'
import type { Sql } from '../../db/index.js'
import { resolverPeriodo, validarEntradaPeriodo, type PeriodoResolvido } from './periodo-relatorio.js'
import { condicaoContato, escopoDaRequisicao, type Escopo } from './escopo.js'

/**
 * RELATÓRIOS "CONTATOS POR DIMENSÃO" (raia E1) — a base genérica dos relatórios do gestor.
 *
 *   GET /v1/relatorios/contatos-por/:dimensao?inicio=yyyy-mm-dd&fim=yyyy-mm-dd
 *
 * COORTE: os contatos CRIADOS no período (fuso do tenant; simulados e inativos ficam fora).
 *   convertido = contato da coorte com ao menos um pedido EFETIVADO dentro do período.
 *   taxa       = convertidos / contatos (0..1; null quando o grupo não tem contatos).
 *   valorCentavos = soma dos pedidos efetivados no período por esses contatos (centavos inteiros).
 * Mesma definição do card "conversão" do Início — um número só, em dois lugares.
 *
 * Limite de 100 grupos (os de mais contatos); `truncado` avisa quando houve corte.
 * Dimensões de domínio fechado (dia-semana, qualificacao) saem sempre completas, na ordem natural.
 *
 * ESCOPO (D3): a coorte é só dos contatos que quem pede enxerga (`condicaoContato`): vendedor a
 * própria carteira, gestor a filial, admin o tenant. Os pedidos contados são os desses contatos.
 */
export const DIMENSOES = ['origem', 'etapa', 'vendedor', 'dia-semana', 'qualificacao', 'uf'] as const
export type Dimensao = (typeof DIMENSOES)[number]
export const LIMITE_GRUPOS = 100

export interface ItemRelatorio {
  readonly chave: string
  readonly rotulo: string
  readonly contatos: number
  readonly convertidos: number
  readonly taxa: number | null
  readonly valorCentavos: number
}

const DIAS_SEMANA: readonly (readonly [string, string])[] = [
  ['1', 'Segunda'], ['2', 'Terça'], ['3', 'Quarta'], ['4', 'Quinta'], ['5', 'Sexta'], ['6', 'Sábado'], ['7', 'Domingo'],
]
const QUALIFICACOES: readonly (readonly [string, string])[] = [
  ['novo', 'Novo'], ['qualificado', 'Qualificado'], ['descartado', 'Descartado'],
]

export function ehDimensao(v: string): v is Dimensao {
  return (DIMENSOES as readonly string[]).includes(v)
}

/** taxa = convertidos/contatos; null sem contatos. Arredondada a 4 casas (0.1234 = 12,34%). */
export function taxaDe(convertidos: number, contatos: number): number | null {
  return contatos > 0 ? Math.round((convertidos / contatos) * 10_000) / 10_000 : null
}

/** Fragmentos SQL por dimensão: joins, chave, rótulo (todos sobre o alias `c` = contato). */
function fragmentos(tx: Sql, dim: Dimensao, fuso: string) {
  switch (dim) {
    case 'origem':
      return {
        joins: tx`LEFT JOIN origem o ON o.tenant_id = c.tenant_id AND o.id = c.origem_id`,
        chave: tx`coalesce(c.origem_id::text, 'sem-origem')`,
        rotulo: tx`coalesce(o.nome, 'Sem origem')`,
      }
    case 'etapa':
      // A etapa ATUAL: a oportunidade aberta; sem aberta, a mais recente (ganha/perdida).
      return {
        joins: tx`LEFT JOIN LATERAL (
                    SELECT op.etapa_id FROM oportunidade op
                     WHERE op.tenant_id = c.tenant_id AND op.contato_id = c.id
                     ORDER BY (op.estado = 'aberta') DESC, op.criado_em DESC LIMIT 1) atual ON true
                  LEFT JOIN funil_etapa fe ON fe.tenant_id = c.tenant_id AND fe.id = atual.etapa_id`,
        chave: tx`coalesce(fe.chave, 'sem-etapa')`,
        rotulo: tx`coalesce(fe.nome, 'Sem etapa')`,
      }
    case 'vendedor':
      return {
        joins: tx`LEFT JOIN carteira_atribuicao ca ON ca.tenant_id = c.tenant_id AND ca.contato_id = c.id AND ca.ate IS NULL
                  LEFT JOIN usuario u ON u.tenant_id = ca.tenant_id AND u.id = ca.usuario_id`,
        chave: tx`coalesce(ca.usuario_id::text, 'sem-vendedor')`,
        rotulo: tx`coalesce(u.nome, 'Sem vendedor')`,
      }
    case 'dia-semana':
      return {
        joins: tx``,
        chave: tx`extract(isodow FROM c.criado_em AT TIME ZONE ${fuso}::text)::int::text`,
        rotulo: tx`''`,
      }
    case 'qualificacao':
      return {
        joins: tx``,
        chave: tx`CASE WHEN c.qualificado IS NULL THEN 'novo' WHEN c.qualificado THEN 'qualificado' ELSE 'descartado' END`,
        rotulo: tx`''`,
      }
    case 'uf':
      return {
        joins: tx`LEFT JOIN contato_endereco e ON e.tenant_id = c.tenant_id AND e.contato_id = c.id AND e.principal`,
        chave: tx`coalesce(nullif(upper(e.uf), ''), 'sem-uf')`,
        rotulo: tx`coalesce(nullif(upper(e.uf), ''), 'Sem UF')`,
      }
  }
}

interface LinhaBruta { chave: string; rotulo: string; contatos: number; convertidos: number; valor: string }

/** Contatos criados no período agrupados por dimensão, com conversão. Só LEITURA, sempre filtrada por período. */
export async function contatosPorDimensao(
  tx: Sql, dim: Dimensao, p: PeriodoResolvido, escopo: Escopo,
): Promise<{ itens: ItemRelatorio[]; truncado: boolean }> {
  const f = fragmentos(tx, dim, p.fuso)
  const linhas = await tx<LinhaBruta[]>`
    WITH coorte AS (
      SELECT c.id, ${f.chave} AS chave, ${f.rotulo} AS rotulo
        FROM contato c ${f.joins}
       WHERE c.tenant_id = tenant_atual() AND c.ativo
         AND coalesce(c.origem_carga, '') <> 'simulacao'
         AND c.criado_em >= ${p.desde} AND c.criado_em < ${p.ate}
         AND ${condicaoContato(tx, escopo, 'c')}
    ), compras AS (
      SELECT pd.contato_id, sum(pd.total_centavos) AS valor
        FROM pedido pd
       WHERE pd.tenant_id = tenant_atual() AND pd.estado = 'efetivado'
         AND pd.efetivado_em >= ${p.desde} AND pd.efetivado_em < ${p.ate}
         AND pd.contato_id IN (SELECT id FROM coorte)
       GROUP BY pd.contato_id
    )
    SELECT k.chave, min(k.rotulo) AS rotulo, count(*)::int AS contatos,
           count(cp.contato_id)::int AS convertidos, coalesce(sum(cp.valor), 0)::text AS valor
      FROM coorte k LEFT JOIN compras cp ON cp.contato_id = k.id
     GROUP BY k.chave
     ORDER BY count(*) DESC, k.chave
     LIMIT ${LIMITE_GRUPOS + 1}`

  const truncado = linhas.length > LIMITE_GRUPOS
  const base = (truncado ? linhas.slice(0, LIMITE_GRUPOS) : linhas).map((l): ItemRelatorio => ({
    chave: l.chave, rotulo: l.rotulo, contatos: l.contatos, convertidos: l.convertidos,
    taxa: taxaDe(l.convertidos, l.contatos), valorCentavos: Number(l.valor),
  }))

  const fechado = dim === 'dia-semana' ? DIAS_SEMANA : dim === 'qualificacao' ? QUALIFICACOES : null
  if (!fechado) return { itens: base, truncado }
  const porChave = new Map(base.map((i) => [i.chave, i]))
  return {
    truncado: false,
    itens: fechado.map(([chave, rotulo]) => {
      const i = porChave.get(chave)
      return { chave, rotulo, contatos: i?.contatos ?? 0, convertidos: i?.convertidos ?? 0,
        taxa: i?.taxa ?? null, valorCentavos: i?.valorCentavos ?? 0 }
    }),
  }
}

export async function rotasRelatorios(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { dimensao: string }; Querystring: { inicio?: string; fim?: string } }>(
    '/v1/relatorios/contatos-por/:dimensao', { preHandler: exigirTenant },
    async (req, reply) => {
      const { dimensao } = req.params
      if (!ehDimensao(dimensao)) return reply.code(404).send({ erro: 'relatorio.dimensao_desconhecida' })
      const { inicio, fim } = req.query
      const erro = validarEntradaPeriodo(inicio, fim)
      if (erro) return reply.code(422).send({ erro })

      const r = await req.comTenant(async (tx) => {
        const p = await resolverPeriodo(tx, inicio, fim)
        return { p, ...(await contatosPorDimensao(tx, dimensao, p, await escopoDaRequisicao(tx, req))) }
      })
      return reply.send({
        dimensao, periodo: { inicio: r.p.inicio, fim: r.p.fim, fuso: r.p.fuso },
        itens: r.itens, truncado: r.truncado,
      })
    },
  )
}
