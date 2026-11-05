import type { FastifyInstance } from 'fastify'
import { ehAgrupamentoCockpit, AGRUPAMENTOS_COCKPIT, type RespostaGruposIndicador } from '@geracrm/shared'
import { exigirTenant } from '../../plugins/tenant.js'
import { contextoDosFiltros, lerFiltros } from '../crm/contatos-filtros.js'
import { gruposDoIndicador, indicadorDaCarteira } from './carteira-higienizacao.js'
import { escopoDaRequisicao } from './escopo.js'
import { exigirPapel } from './papel.js'

/**
 * HIGIENIZAÇÃO DA CARTEIRA (D2) — só leitura.
 *
 *   GET /v1/gestao/carteira/indicador?filialId&vendedorId           → { ativos, comProximoPasso, semProximoPasso, percentual, meta }
 *   GET /v1/gestao/carteira/indicador/grupos?agrupar=filial|vendedor → o mesmo, por grupo (pior primeiro)
 *
 * A LISTA da tela é `GET /v1/contatos?semProximoPasso=true&carteiraAtiva=true&…` e o lote é
 * `POST /v1/contatos/acoes-em-massa/:acao` — nada duplicado aqui.
 * ⚠️ gestor/supervisor/admin (vendedor → 403), sempre no escopo da D3. Tenant do token.
 */
export async function rotasCarteiraHigienizacao(app: FastifyInstance): Promise<void> {
  const pre = [exigirTenant, exigirPapel('gestor', 'supervisor')]

  // Só filialId/vendedorId valem aqui: os demais filtros da lista de contatos não entram no indicador.
  const filtrosDe = (query: unknown) => {
    const q = (query ?? {}) as Record<string, unknown>
    return lerFiltros({ filialId: q.filialId, vendedorId: q.vendedorId })
  }
  const invalido = { erro: 'carteira.filtro_invalido', mensagem: 'Algum filtro é inválido.' }

  app.get('/v1/gestao/carteira/indicador', { preHandler: pre }, async (req, reply) => {
    const lf = filtrosDe(req.query)
    if (!lf.ok) return reply.code(422).send({ ...invalido, campos: lf.campos })
    return req.comTenant(async (tx) => {
      const ctx = await contextoDosFiltros(tx, lf.filtros)
      return indicadorDaCarteira(tx, { escopo: await escopoDaRequisicao(tx, req), filtros: lf.filtros, ...ctx })
    })
  })

  app.get('/v1/gestao/carteira/indicador/grupos', { preHandler: pre }, async (req, reply) => {
    const agrupar = (req.query as { agrupar?: unknown }).agrupar ?? 'vendedor'
    if (!ehAgrupamentoCockpit(agrupar)) {
      return reply.code(422).send({ erro: 'carteira.agrupamento_invalido', mensagem: `Agrupe por: ${AGRUPAMENTOS_COCKPIT.join(' ou ')}.`, campos: ['agrupar'] })
    }
    const lf = filtrosDe(req.query)
    if (!lf.ok) return reply.code(422).send({ ...invalido, campos: lf.campos })
    return req.comTenant(async (tx): Promise<RespostaGruposIndicador> => {
      const ctx = await contextoDosFiltros(tx, lf.filtros)
      const grupos = await gruposDoIndicador(tx, { escopo: await escopoDaRequisicao(tx, req), filtros: lf.filtros, ...ctx }, agrupar)
      return { agrupar, grupos }
    })
  })
}
