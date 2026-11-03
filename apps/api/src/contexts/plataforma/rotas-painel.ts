import type { FastifyInstance } from 'fastify'
import { exigirTenant } from '../../plugins/tenant.js'
import { resolverPeriodo, validarEntradaPeriodo } from './periodo-relatorio.js'
import { contatosPorDimensao, taxaDe } from './rotas-relatorios.js'

/**
 * Painel Início v2 (raia E1) — o negócio num período livre, em poucas leituras agregadas.
 *
 *   GET /v1/painel/inicio?inicio=yyyy-mm-dd&fim=yyyy-mm-dd
 *
 * Período: datas locais do tenant, inclusivas, no máx. 366 dias; sem parâmetros = do dia 1 do mês atual
 * até hoje (`now()` do banco no fuso do tenant). Inválido = 422 tipificado (`periodo.*`).
 *
 * DEFINIÇÕES (iguais às de `/v1/relatorios/contatos-por`):
 *   contatosNovos      contatos criados no período (simulados e inativos fora).
 *   pedidos            pedidos com estado `efetivado` e `efetivado_em` no período (qtd e valor em centavos).
 *   ticketMedio        valor / qtd, arredondado em centavos; null sem pedidos.
 *   conversao          contatos NOVOS do período com ao menos um pedido efetivado no período
 *                      / contatosNovos (0..1; null sem contatos novos). É coorte, não razão pedidos/contatos.
 *   tarefas            estado atual (não do período): abertas e, entre elas, as atrasadas (vence_em < now()).
 *   pedidosPorMes      últimos 6 meses civis terminando no mês de `fim` (meses sem pedido = 0).
 *   qualificacao       distribuição dos contatos novos do período em novo/qualificado/descartado.
 *   ranking            top 10 vendedores por valor de pedidos efetivados no período.
 *   contatosRecentes / proximasTarefas   10 itens cada (recentes: os últimos criados; tarefas: abertas
 *                      por vencimento, atrasadas primeiro). São lista curta de painel, não grid de domínio.
 *
 * TODO(D3): aplicar `escopoDoUsuario` (vendedor só o próprio) quando a raia D3 entrar.
 */
export async function rotasPainel(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { inicio?: string; fim?: string } }>(
    '/v1/painel/inicio', { preHandler: exigirTenant },
    async (req, reply) => {
      const { inicio, fim } = req.query
      const erro = validarEntradaPeriodo(inicio, fim)
      if (erro) return reply.code(422).send({ erro })

      const dados = await req.comTenant(async (tx) => {
        const p = await resolverPeriodo(tx, inicio, fim)

        const [novos] = await tx<{ n: number }[]>`
          SELECT count(*)::int AS n FROM contato
           WHERE tenant_id = tenant_atual() AND ativo AND coalesce(origem_carga, '') <> 'simulacao'
             AND criado_em >= ${p.desde} AND criado_em < ${p.ate}`

        const [ped] = await tx<{ n: number; total: string }[]>`
          SELECT count(*)::int AS n, coalesce(sum(total_centavos), 0)::text AS total FROM pedido
           WHERE tenant_id = tenant_atual() AND estado = 'efetivado'
             AND efetivado_em >= ${p.desde} AND efetivado_em < ${p.ate}`

        // Conversão = a coorte dos "contatos por qualificação" (mesma função do relatório).
        const qualificacao = await contatosPorDimensao(tx, 'qualificacao', p)

        const [tar] = await tx<{ pendentes: number; atrasadas: number }[]>`
          SELECT count(*)::int AS pendentes, (count(*) FILTER (WHERE vence_em < now()))::int AS atrasadas
            FROM tarefa WHERE tenant_id = tenant_atual() AND estado = 'aberta'`

        // 6 meses civis no fuso do tenant, terminando no mês de `fim`; meses vazios entram com zero.
        const porMes = await tx<{ mes: string; n: number; total: string }[]>`
          WITH meses AS (
            SELECT (date_trunc('month', ${p.fim}::date::timestamp) - make_interval(months => g))::date AS mes
              FROM generate_series(0, 5) g
          )
          SELECT to_char(m.mes, 'YYYY-MM') AS mes, coalesce(a.n, 0)::int AS n, coalesce(a.total, 0)::text AS total
            FROM meses m
            LEFT JOIN (
              SELECT date_trunc('month', efetivado_em AT TIME ZONE ${p.fuso}::text)::date AS mes,
                     count(*) AS n, sum(total_centavos) AS total
                FROM pedido
               WHERE tenant_id = tenant_atual() AND estado = 'efetivado'
                 AND efetivado_em >= (date_trunc('month', ${p.fim}::date::timestamp) - interval '5 months')::timestamp AT TIME ZONE ${p.fuso}::text
                 AND efetivado_em <  (date_trunc('month', ${p.fim}::date::timestamp) + interval '1 month')::timestamp AT TIME ZONE ${p.fuso}::text
               GROUP BY 1
            ) a ON a.mes = m.mes
           ORDER BY m.mes`

        const ranking = await tx<{ usuario_id: string | null; nome: string | null; n: number; total: string }[]>`
          SELECT pd.vendedor_id AS usuario_id, u.nome, count(*)::int AS n, sum(pd.total_centavos)::text AS total
            FROM pedido pd
            LEFT JOIN usuario u ON u.tenant_id = pd.tenant_id AND u.id = pd.vendedor_id
           WHERE pd.tenant_id = tenant_atual() AND pd.estado = 'efetivado'
             AND pd.efetivado_em >= ${p.desde} AND pd.efetivado_em < ${p.ate}
           GROUP BY pd.vendedor_id, u.nome
           ORDER BY sum(pd.total_centavos) DESC, pd.vendedor_id NULLS LAST LIMIT 10`

        const recentes = await tx<{ id: string; nome: string; criado_em: Date; qualificado: boolean | null }[]>`
          SELECT id, nome, criado_em, qualificado FROM contato
           WHERE tenant_id = tenant_atual() AND ativo AND coalesce(origem_carga, '') <> 'simulacao'
           ORDER BY criado_em DESC, id DESC LIMIT 10`

        const proximas = await tx<{ id: string; titulo: string; vence_em: Date; tipo: string; contato_id: string | null; contato_nome: string | null }[]>`
          SELECT t.id, t.titulo, t.vence_em, t.tipo, t.contato_id, c.nome AS contato_nome
            FROM tarefa t
            LEFT JOIN contato c ON c.tenant_id = t.tenant_id AND c.id = t.contato_id
           WHERE t.tenant_id = tenant_atual() AND t.estado = 'aberta'
           ORDER BY t.vence_em, t.id LIMIT 10`

        return { p, novos, ped, qualificacao, tar, porMes, ranking, recentes, proximas }
      })

      const novos = dados.novos?.n ?? 0
      const qtd = dados.ped?.n ?? 0
      const valor = Number(dados.ped?.total ?? 0)
      const convertidos = dados.qualificacao.itens.reduce((s, i) => s + i.convertidos, 0)

      return reply.send({
        periodo: { inicio: dados.p.inicio, fim: dados.p.fim, fuso: dados.p.fuso },
        contatosNovos: novos,
        pedidos: { quantidade: qtd, valorCentavos: valor },
        ticketMedioCentavos: qtd > 0 ? Math.round(valor / qtd) : null,
        conversao: { convertidos, contatosNovos: novos, taxa: taxaDe(convertidos, novos) },
        tarefas: { pendentes: dados.tar?.pendentes ?? 0, atrasadas: dados.tar?.atrasadas ?? 0 },
        pedidosPorMes: dados.porMes.map((m) => ({ mes: m.mes, quantidade: m.n, valorCentavos: Number(m.total) })),
        qualificacao: dados.qualificacao.itens.map((i) => ({ chave: i.chave, rotulo: i.rotulo, contatos: i.contatos })),
        ranking: dados.ranking.map((r) => ({
          usuarioId: r.usuario_id, nome: r.nome ?? 'Sem vendedor', pedidos: r.n, valorCentavos: Number(r.total),
        })),
        contatosRecentes: dados.recentes.map((c) => ({
          id: c.id, nome: c.nome, criadoEm: c.criado_em.toISOString(),
          qualificacao: c.qualificado === null ? 'novo' : c.qualificado ? 'qualificado' : 'descartado',
        })),
        proximasTarefas: dados.proximas.map((t) => ({
          id: t.id, titulo: t.titulo, venceEm: t.vence_em.toISOString(), tipo: t.tipo,
          contatoId: t.contato_id, contatoNome: t.contato_nome,
        })),
      })
    },
  )
}
