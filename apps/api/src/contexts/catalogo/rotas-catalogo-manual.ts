import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { perfilDeCotacao, produtoEntrada, skuEntrada } from '@geracrm/shared'
import { exigirTenant } from '../../plugins/tenant.js'
import { detalharProduto, detalharProdutos } from './busca.js'
import {
  adicionarSku, atualizarProduto, atualizarSku, criarProdutoManual, desativarProduto, desativarSku,
  type FalhaCatalogo,
} from './escrita-manual.js'
import { indexarProduto, reindexarTenant } from './indexador.js'

/**
 * CATÁLOGO PRÓPRIO — CRUD de produto/SKU/preço/saldo cadastrados à mão (ADR-025).
 *
 * Convive com o catálogo do ERP nas mesmas tabelas. A regra de origem por
 * campo (ADR-008) é aplicada em `escrita-manual.ts`: produto do ERP só aceita
 * o que o ERP não tem (descrição longa, imagens, categoria); o resto responde
 * 409 `catalogo.origem_erp` com os campos vetados — a tela mostra o porquê.
 *
 * Toda escrita reindexa o produto na mesma transação: o agente busca pelo
 * índice, e índice atrasado é produto que "não existe" na conversa.
 */

const TAMANHO_PAGINA = 30
const SEPARADOR_CURSOR = '§'

const criarProdutoCorpo = produtoEntrada.extend({
  skus: z.array(skuEntrada).max(100).optional(),
})
const atualizarProdutoCorpo = produtoEntrada.partial()

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function responderFalha(reply: FastifyReply, falha: FalhaCatalogo) {
  switch (falha.erro) {
    case 'catalogo.referencia_duplicada':
      return reply.code(422).send({ erro: falha.erro, mensagem: 'Já existe um produto com esta referência.' })
    case 'catalogo.produto_nao_encontrado':
      return reply.code(404).send({ erro: falha.erro, mensagem: 'Produto não encontrado.' })
    case 'catalogo.sku_nao_encontrado':
      return reply.code(404).send({ erro: falha.erro, mensagem: 'Variação não encontrada.' })
    case 'catalogo.origem_erp':
      return reply.code(409).send({
        erro: falha.erro, campos: falha.campos,
        mensagem: 'Este registro vem do ERP: ' + falha.campos.join(', ') + ' só muda lá. '
          + 'No CRM você edita descrição longa, imagens e categoria.',
      })
  }
}

function entradaInvalida(reply: FastifyReply, detalhe: z.ZodError) {
  return reply.code(422).send({
    erro: 'catalogo.entrada_invalida',
    mensagem: 'Dados do catálogo inválidos.',
    campos: detalhe.issues.map((i) => i.path.join('.')).filter(Boolean),
  })
}

function lerCursor(bruto: string | undefined): { descricao: string; id: string } | null | 'invalido' {
  if (!bruto) return null
  const [descricao, id] = Buffer.from(bruto, 'base64url').toString('utf8').split(SEPARADOR_CURSOR)
  if (!descricao || !id || !UUID.test(id)) return 'invalido'
  return { descricao, id }
}

export async function rotasCatalogoManual(app: FastifyInstance): Promise<void> {
  app.post('/v1/catalogo/produtos', { preHandler: exigirTenant }, async (req, reply) => {
    const parsed = criarProdutoCorpo.safeParse(req.body)
    if (!parsed.success) return entradaInvalida(reply, parsed.error)

    const r = await req.comTenant(async (tx) => {
      const criado = await criarProdutoManual(tx, parsed.data)
      if (criado.ok) await indexarProduto(tx, criado.valor.id)
      return criado
    })
    if (!r.ok) return responderFalha(reply, r.falha)
    return reply.code(201).send({ id: r.valor.id, skus: r.valor.skus.map((id) => ({ id })) })
  })

  // Lista PAGINADA por cursor (descricao, id). Filtros no banco, com índice.
  app.get<{ Querystring: { cursor?: string; busca?: string; perfil?: string; origem?: string; inativos?: string } }>(
    '/v1/catalogo/produtos', { preHandler: exigirTenant },
    async (req, reply) => {
      const q = req.query
      const cursor = lerCursor(q.cursor)
      if (cursor === 'invalido') return reply.code(422).send({ erro: 'cursor.invalido', mensagem: 'Cursor inválido.' })
      const busca = (q.busca ?? '').trim()
      const origem = q.origem === 'erp' || q.origem === 'manual' ? q.origem : null
      const incluirInativos = q.inativos === '1' || q.inativos === 'true'
      const perfil = perfilDeCotacao(q.perfil)

      const pagina = await req.comTenant(async (tx) => {
        const ids = await tx<{ id: string; descricao: string }[]>`
          SELECT p.id, p.descricao
            FROM produto p
           WHERE p.tenant_id = tenant_atual()
             AND ${incluirInativos ? tx`true` : tx`p.ativo`}
             AND ${origem ? tx`p.origem = ${origem}` : tx`true`}
             AND ${busca === '' ? tx`true` : tx`(p.descricao ILIKE ${'%' + busca + '%'} OR p.referencia ILIKE ${'%' + busca + '%'})`}
             AND ${cursor === null ? tx`true` : tx`(p.descricao, p.id) > (${cursor.descricao}, ${cursor.id}::uuid)`}
           ORDER BY p.descricao ASC, p.id ASC
           LIMIT ${TAMANHO_PAGINA + 1}`
        const temMais = ids.length > TAMANHO_PAGINA
        const pedacos = temMais ? ids.slice(0, TAMANHO_PAGINA) : ids
        const detalhes = await detalharProdutos(tx, pedacos.map((i) => i.id), perfil, { incluirSkusInativos: incluirInativos })
        const porId = new Map(detalhes.map((d) => [d.id, d]))
        const ultimo = pedacos[pedacos.length - 1]
        return {
          itens: pedacos.map((i) => porId.get(i.id)).filter((d) => d !== undefined),
          proximoCursor: temMais && ultimo
            ? Buffer.from(`${ultimo.descricao}${SEPARADOR_CURSOR}${ultimo.id}`).toString('base64url')
            : null,
        }
      })
      return reply.send(pagina)
    },
  )

  app.get<{ Params: { id: string }; Querystring: { perfil?: string; inativos?: string } }>(
    '/v1/catalogo/produtos/:id', { preHandler: exigirTenant },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return responderFalha(reply, { erro: 'catalogo.produto_nao_encontrado' })
      const perfil = perfilDeCotacao(req.query.perfil)
      const incluirSkusInativos = req.query.inativos === '1' || req.query.inativos === 'true'
      const produto = await req.comTenant((tx) => detalharProduto(tx, req.params.id, perfil, { incluirSkusInativos }))
      if (!produto) return responderFalha(reply, { erro: 'catalogo.produto_nao_encontrado' })
      return reply.send(produto)
    },
  )

  app.patch<{ Params: { id: string } }>(
    '/v1/catalogo/produtos/:id', { preHandler: exigirTenant },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return responderFalha(reply, { erro: 'catalogo.produto_nao_encontrado' })
      const parsed = atualizarProdutoCorpo.safeParse(req.body)
      if (!parsed.success) return entradaInvalida(reply, parsed.error)
      const r = await req.comTenant(async (tx) => {
        const r = await atualizarProduto(tx, req.params.id, parsed.data)
        if (r.ok) await indexarProduto(tx, r.valor.id)
        return r
      })
      if (!r.ok) return responderFalha(reply, r.falha)
      return reply.send({ id: r.valor.id })
    },
  )

  // Soft delete: `ativo = false`. O produto continua nos pedidos antigos.
  app.delete<{ Params: { id: string } }>(
    '/v1/catalogo/produtos/:id', { preHandler: exigirTenant },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return responderFalha(reply, { erro: 'catalogo.produto_nao_encontrado' })
      const r = await req.comTenant(async (tx) => {
        const r = await desativarProduto(tx, req.params.id)
        if (r.ok) await indexarProduto(tx, r.valor.id)
        return r
      })
      if (!r.ok) return responderFalha(reply, r.falha)
      return reply.send({ id: r.valor.id, ativo: false })
    },
  )

  app.post<{ Params: { id: string } }>(
    '/v1/catalogo/produtos/:id/skus', { preHandler: exigirTenant },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return responderFalha(reply, { erro: 'catalogo.produto_nao_encontrado' })
      const parsed = skuEntrada.safeParse(req.body)
      if (!parsed.success) return entradaInvalida(reply, parsed.error)
      const r = await req.comTenant(async (tx) => {
        const r = await adicionarSku(tx, req.params.id, parsed.data)
        if (r.ok) await indexarProduto(tx, req.params.id)
        return r
      })
      if (!r.ok) return responderFalha(reply, r.falha)
      return reply.code(201).send({ id: r.valor.id })
    },
  )

  app.patch<{ Params: { id: string; skuId: string } }>(
    '/v1/catalogo/produtos/:id/skus/:skuId', { preHandler: exigirTenant },
    async (req, reply) => {
      if (!UUID.test(req.params.id) || !UUID.test(req.params.skuId)) {
        return responderFalha(reply, { erro: 'catalogo.sku_nao_encontrado' })
      }
      const parsed = skuEntrada.safeParse(req.body)
      if (!parsed.success) return entradaInvalida(reply, parsed.error)
      const r = await req.comTenant(async (tx) => {
        const r = await atualizarSku(tx, req.params.id, req.params.skuId, parsed.data)
        if (r.ok) await indexarProduto(tx, req.params.id)
        return r
      })
      if (!r.ok) return responderFalha(reply, r.falha)
      return reply.send({ id: r.valor.id })
    },
  )

  app.delete<{ Params: { id: string; skuId: string } }>(
    '/v1/catalogo/produtos/:id/skus/:skuId', { preHandler: exigirTenant },
    async (req, reply) => {
      if (!UUID.test(req.params.id) || !UUID.test(req.params.skuId)) {
        return responderFalha(reply, { erro: 'catalogo.sku_nao_encontrado' })
      }
      const r = await req.comTenant(async (tx) => {
        const r = await desativarSku(tx, req.params.id, req.params.skuId)
        if (r.ok) await indexarProduto(tx, req.params.id)
        return r
      })
      if (!r.ok) return responderFalha(reply, r.falha)
      return reply.send({ id: r.valor.id, ativo: false })
    },
  )

  // Reindexa o catálogo do tenant (depois de uma carga, ou para reconstruir o índice).
  app.post('/v1/catalogo/reindexar', { preHandler: exigirTenant }, async (req, reply) => {
    const relatorio = await req.comTenant((tx) => reindexarTenant(tx, { lote: 200 }))
    return reply.send(relatorio)
  })
}
