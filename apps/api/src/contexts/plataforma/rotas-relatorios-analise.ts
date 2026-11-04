import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { exigirTenant } from '../../plugins/tenant.js'
import type { Sql } from '../../db/index.js'
import { resolverPeriodo, validarEntradaPeriodo, type PeriodoResolvido } from './periodo-relatorio.js'
import { escopoDaRequisicao, type Escopo } from './escopo.js'
import { lerLimiteMin } from './relatorios-whatsapp.js'
import {
  coletarParaCsv, contatosParaCsv, ehUuid, lerCursor, lerFiltros, listarContatos, type FiltrosContatos,
} from './relatorios-contatos.js'
import {
  comparativoVendedores, desempenhoCadastro, ehEixoOpcoes, ehEixoRaioX, imprimiveis, lerVendedores, motivosDePerda,
  opcoesDoEixo, raioX, visaoGeral,
} from './relatorios-analise.js'

/**
 * RELATÓRIOS DE ANÁLISE — 2ª leva (raia E3), ao lado de `rotas-relatorios.ts` (E1) e `rotas-relatorios-gestao.ts` (E2):
 *
 *   GET /v1/relatorios/comparativo?vendedores=id,id,...   1 a 10 vendedores (422 acima)
 *   GET /v1/relatorios/visao-geral
 *   GET /v1/relatorios/contatos                           lista por cursor + filtros (também é o detalhamento da visão geral)
 *   GET /v1/relatorios/contatos.csv                       até 1000 linhas, lidas em páginas por cursor (`x-truncado`)
 *   GET /v1/relatorios/raio-x/:eixo/:chave                eixo = formulario | vendedor | filial
 *   GET /v1/relatorios/desempenho
 *   GET /v1/relatorios/motivos-perda
 *   GET /v1/relatorios/imprimiveis                        (+ limiteMin) funil, origens, motivos de perda, WhatsApp
 *   GET /v1/relatorios/opcoes/:eixo?busca&cursor          vendedor | filial | formulario | origem — para os selects
 *
 * Todos: `?inicio&fim` (ou nenhum = mês atual), 422 `periodo.*` via `periodo-relatorio.ts`; o tenant vem do token;
 * escopo da D3 em cada agregado; só leitura.
 */
type Query = Record<string, string | undefined>
interface Contexto { tx: Sql; p: PeriodoResolvido; escopo: Escopo }

async function servir<T extends object>(
  req: FastifyRequest<{ Querystring: Query }>, reply: FastifyReply, fn: (c: Contexto) => Promise<T | { status: number; erro: string }>,
) {
  const { inicio, fim } = req.query
  const erro = validarEntradaPeriodo(inicio, fim)
  if (erro) return reply.code(422).send({ erro })
  const r = await req.comTenant(async (tx) => {
    const p = await resolverPeriodo(tx, inicio, fim)
    return { p, dados: await fn({ tx, p, escopo: await escopoDaRequisicao(tx, req) }) }
  })
  if ('erro' in r.dados && 'status' in r.dados) return reply.code(r.dados.status as number).send({ erro: r.dados.erro })
  return reply.send({ periodo: { inicio: r.p.inicio, fim: r.p.fim, fuso: r.p.fuso }, ...r.dados })
}

const LIMITE_MAX = 100
const LIMITE_PADRAO = 50

function lerLimite(v: string | undefined): number | null {
  if (v === undefined) return LIMITE_PADRAO
  if (!/^\d{1,3}$/.test(v)) return null
  const n = Number(v)
  return n >= 1 && n <= LIMITE_MAX ? n : null
}

export async function rotasRelatoriosAnalise(app: FastifyInstance): Promise<void> {
  const rota = { preHandler: exigirTenant }

  app.get<{ Querystring: Query }>('/v1/relatorios/comparativo', rota, async (req, reply) => {
    const v = lerVendedores(req.query.vendedores)
    if ('erro' in v) return reply.code(422).send({ erro: v.erro })
    return servir(req, reply, ({ tx, p, escopo }) => comparativoVendedores(tx, p, escopo, v.ids))
  })

  app.get<{ Querystring: Query }>('/v1/relatorios/visao-geral', rota, async (req, reply) =>
    servir(req, reply, ({ tx, p, escopo }) => visaoGeral(tx, p, escopo)))

  app.get<{ Querystring: Query }>('/v1/relatorios/contatos', rota, async (req, reply) => {
    const f = lerFiltros(req.query)
    if ('campoInvalido' in f) return reply.code(422).send({ erro: 'relatorio.filtro_invalido', campo: f.campoInvalido })
    const limite = lerLimite(req.query.limite)
    if (limite === null) return reply.code(422).send({ erro: 'relatorio.limite_invalido' })
    const cursor = req.query.cursor ? lerCursor(req.query.cursor) : null
    if (req.query.cursor && cursor === null) return reply.code(422).send({ erro: 'relatorio.cursor_invalido' })
    return servir(req, reply, ({ tx, p, escopo }) => listarContatos(tx, p, escopo, f.filtros, cursor, limite))
  })

  app.get<{ Querystring: Query }>('/v1/relatorios/contatos.csv', rota, async (req, reply) => {
    const f = lerFiltros(req.query)
    if ('campoInvalido' in f) return reply.code(422).send({ erro: 'relatorio.filtro_invalido', campo: f.campoInvalido })
    const { inicio, fim } = req.query
    const erro = validarEntradaPeriodo(inicio, fim)
    if (erro) return reply.code(422).send({ erro })
    const periodo = await req.comTenant((tx) => resolverPeriodo(tx, inicio, fim))
    const filtros: FiltrosContatos = f.filtros
    // Cada lote (<= 250 linhas) numa transação curta; o teto é de 1000 linhas no total.
    const { linhas, truncado } = await coletarParaCsv(
      (fn) => req.comTenant(fn),
      async (tx, cursor, limite) => listarContatos(tx, periodo, await escopoDaRequisicao(tx, req), filtros, cursor, limite),
    )
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="contatos-${periodo.inicio}-a-${periodo.fim}.csv"`)
      .header('x-truncado', truncado ? 'true' : 'false')
      .header('cache-control', 'no-store')
      .send(contatosParaCsv(linhas, periodo.fuso))
  })

  app.get<{ Params: { eixo: string; chave: string }; Querystring: Query }>('/v1/relatorios/raio-x/:eixo/:chave', rota, async (req, reply) => {
    const { eixo, chave } = req.params
    if (!ehEixoRaioX(eixo)) return reply.code(404).send({ erro: 'relatorio.dimensao_desconhecida' })
    if (!ehUuid(chave)) return reply.code(422).send({ erro: 'relatorio.chave_invalida' })
    return servir(req, reply, async ({ tx, p, escopo }) => {
      const r = await raioX(tx, p, escopo, eixo, chave)
      return r ?? { status: 404, erro: 'relatorio.nao_encontrado' }
    })
  })

  app.get<{ Querystring: Query }>('/v1/relatorios/desempenho', rota, async (req, reply) =>
    servir(req, reply, ({ tx, p, escopo }) => desempenhoCadastro(tx, p, escopo)))

  app.get<{ Querystring: Query }>('/v1/relatorios/motivos-perda', rota, async (req, reply) =>
    servir(req, reply, ({ tx, p, escopo }) => motivosDePerda(tx, p, escopo)))

  app.get<{ Querystring: Query }>('/v1/relatorios/imprimiveis', rota, async (req, reply) => {
    const limiteMin = lerLimiteMin(req.query.limiteMin)
    if (limiteMin === null) return reply.code(422).send({ erro: 'relatorio.limite_invalido' })
    return servir(req, reply, ({ tx, p, escopo }) => imprimiveis(tx, p, escopo, limiteMin))
  })

  app.get<{ Params: { eixo: string }; Querystring: Query }>('/v1/relatorios/opcoes/:eixo', rota, async (req, reply) => {
    const { eixo } = req.params
    if (!ehEixoOpcoes(eixo)) return reply.code(404).send({ erro: 'relatorio.dimensao_desconhecida' })
    const busca = (req.query.busca ?? '').slice(0, 60)
    const r = await req.comTenant(async (tx) => opcoesDoEixo(tx, await escopoDaRequisicao(tx, req), eixo, busca, req.query.cursor ?? null))
    if (r === 'cursor_invalido') return reply.code(422).send({ erro: 'relatorio.cursor_invalido' })
    return reply.send(r)
  })
}
