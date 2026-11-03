import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { exigirTenant } from '../../plugins/tenant.js'
import type { Sql } from '../../db/index.js'
import { resolverPeriodo, validarEntradaPeriodo, type PeriodoResolvido } from './periodo-relatorio.js'
import { escopoDaRequisicao, type Escopo } from './escopo.js'
import { ehDimensaoVendas, vendasPorDimensao } from './relatorios-vendas.js'
import { desempenhoVendedores, operacional, tempoDeConversao } from './relatorios-gestao.js'
import { lerLimiteMin, relatorioWhatsapp } from './relatorios-whatsapp.js'

/**
 * RELATÓRIOS DE GESTÃO — 1ª leva (raia E2), ao lado de `contatos-por` (E1, em rotas-relatorios.ts):
 *
 *   GET /v1/relatorios/vendas-por/:dimensao   dia | dia-semana | produto | cliente | origem | vendedor | canal
 *   GET /v1/relatorios/tempo-conversao
 *   GET /v1/relatorios/vendedores
 *   GET /v1/relatorios/operacional
 *   GET /v1/relatorios/whatsapp                (+ limiteMin)
 *
 * Todos: `?inicio=yyyy-mm-dd&fim=yyyy-mm-dd` (ou nenhum = mês atual até hoje), validados por
 * `periodo-relatorio.ts` (422 com código); o tenant vem do token; o escopo da D3 vale em cada agregado.
 * Só leitura; cada um devolve `periodo` com o fuso usado.
 */
type Query = { inicio?: string; fim?: string; limiteMin?: string }
interface Contexto { tx: Sql; p: PeriodoResolvido; escopo: Escopo }

/** Valida o período, abre o tenant, resolve período e escopo e roda o relatório. */
async function servir<T>(
  req: FastifyRequest<{ Querystring: Query }>, reply: FastifyReply, fn: (c: Contexto) => Promise<T>,
) {
  const { inicio, fim } = req.query
  const erro = validarEntradaPeriodo(inicio, fim)
  if (erro) return reply.code(422).send({ erro })
  const r = await req.comTenant(async (tx) => {
    const p = await resolverPeriodo(tx, inicio, fim)
    return { p, dados: await fn({ tx, p, escopo: await escopoDaRequisicao(tx, req) }) }
  })
  return reply.send({ periodo: { inicio: r.p.inicio, fim: r.p.fim, fuso: r.p.fuso }, ...r.dados })
}

export async function rotasRelatoriosGestao(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { dimensao: string }; Querystring: Query }>(
    '/v1/relatorios/vendas-por/:dimensao', { preHandler: exigirTenant },
    async (req, reply) => {
      const { dimensao } = req.params
      if (!ehDimensaoVendas(dimensao)) return reply.code(404).send({ erro: 'relatorio.dimensao_desconhecida' })
      return servir(req, reply, async ({ tx, p, escopo }) => ({ dimensao, ...(await vendasPorDimensao(tx, dimensao, p, escopo)) }))
    },
  )

  app.get<{ Querystring: Query }>('/v1/relatorios/tempo-conversao', { preHandler: exigirTenant }, async (req, reply) =>
    servir(req, reply, async ({ tx, p, escopo }) => {
      const r = await tempoDeConversao(tx, p, escopo)
      return {
        contatos: r.resumo.contatos, mediaDias: r.resumo.mediaDias, maisRapidaDias: r.resumo.maisRapidaDias,
        maisLentaDias: r.resumo.maisLentaDias, faixas: r.faixas, porVendedor: r.porVendedor,
        porVendedorTruncado: r.porVendedorTruncado,
      }
    }))

  app.get<{ Querystring: Query }>('/v1/relatorios/vendedores', { preHandler: exigirTenant }, async (req, reply) =>
    servir(req, reply, ({ tx, p, escopo }) => desempenhoVendedores(tx, p, escopo)))

  app.get<{ Querystring: Query }>('/v1/relatorios/operacional', { preHandler: exigirTenant }, async (req, reply) =>
    servir(req, reply, ({ tx, p, escopo }) => operacional(tx, p, escopo)))

  app.get<{ Querystring: Query }>('/v1/relatorios/whatsapp', { preHandler: exigirTenant }, async (req, reply) => {
    const limiteMin = lerLimiteMin(req.query.limiteMin)
    if (limiteMin === null) return reply.code(422).send({ erro: 'relatorio.limite_invalido' })
    return servir(req, reply, async ({ tx, p, escopo }) => ({ limiteMin, ...(await relatorioWhatsapp(tx, p, escopo, limiteMin)) }))
  })
}
