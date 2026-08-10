import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { exigirTenant } from '../../plugins/tenant.js'
import { garantirUsuarioId } from '../atendimento/rotas-fila.js'

const PAGINA = 30

/**
 * Listas (públicos salvos) — CRUD de público curado + gestão de membros.
 * ⚠️ Estática por escolha humana, diferente do segmento RFV (derivado). Tenant
 * sempre de tenant_atual() (ADR-001). Membros paginados por cursor (nome, id).
 */
export async function rotasLista(app: FastifyInstance): Promise<void> {
  // Todas as listas do tenant, com a contagem de membros. Conjunto pequeno.
  app.get('/v1/listas', { preHandler: exigirTenant }, async (req, reply) => {
    const linhas = await req.comTenant((tx) => tx<{ id: string; nome: string; descricao: string | null; membros: number }[]>`
      SELECT l.id, l.nome, l.descricao,
             (SELECT count(*)::int FROM lista_membro m WHERE m.tenant_id = l.tenant_id AND m.lista_id = l.id) AS membros
        FROM lista l
       WHERE l.tenant_id = tenant_atual()
       ORDER BY l.nome ASC LIMIT 200`)
    return reply.send({ itens: linhas.map((l) => ({ id: l.id, nome: l.nome, descricao: l.descricao, membros: l.membros })) })
  })

  // Criar uma lista.
  app.post<{ Body: { nome?: string; descricao?: string } }>(
    '/v1/listas', { preHandler: exigirTenant },
    async (req, reply) => {
      const nome = req.body?.nome?.trim()
      if (!nome) return reply.code(422).send({ erro: 'lista.nome_obrigatorio', mensagem: 'Dê um nome à lista.' })
      const id = randomUUID()
      try {
        await req.comTenant(async (tx) => {
          const eu = await garantirUsuarioId(tx, req)
          await tx`INSERT INTO lista (tenant_id, id, nome, descricao, criado_por)
                   VALUES (tenant_atual(), ${id}, ${nome}, ${req.body?.descricao?.trim() || null}, ${eu})`
        })
        return reply.code(201).send({ id })
      } catch (e) {
        if (e instanceof Error && e.message.includes('lista_nome_unico')) {
          return reply.code(409).send({ erro: 'lista.nome_duplicado', mensagem: 'Já existe uma lista com esse nome.' })
        }
        throw e
      }
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/v1/listas/:id', { preHandler: exigirTenant },
    async (req, reply) => {
      const [r] = await req.comTenant((tx) => tx`
        DELETE FROM lista WHERE tenant_id = tenant_atual() AND id = ${req.params.id} RETURNING id`)
      if (!r) return reply.code(404).send({ erro: 'lista.nao_encontrada' })
      return reply.send({ ok: true })
    },
  )

  // Membros de uma lista (cursor por nome, id).
  app.get<{ Params: { id: string }; Querystring: { cursor?: string } }>(
    '/v1/listas/:id/membros', { preHandler: exigirTenant },
    async (req, reply) => {
      let curNome: string | null = null, curId: string | null = null
      if (req.query.cursor) {
        const [nome, id] = Buffer.from(req.query.cursor, 'base64url').toString('utf8').split('§')
        if (!nome || !id) return reply.code(422).send({ erro: 'cursor.invalido' })
        curNome = nome; curId = id
      }
      const linhas = await req.comTenant((tx) => tx<{ id: string; nome: string }[]>`
        SELECT c.id, c.nome
          FROM lista_membro m
          JOIN contato c ON c.tenant_id = m.tenant_id AND c.id = m.contato_id
         WHERE m.tenant_id = tenant_atual() AND m.lista_id = ${req.params.id}
           AND ${curNome === null ? tx`true` : tx`(c.nome, c.id) > (${curNome}, ${curId}::uuid)`}
         ORDER BY c.nome ASC, c.id ASC LIMIT ${PAGINA + 1}`)
      const temMais = linhas.length > PAGINA
      const pagina = temMais ? linhas.slice(0, PAGINA) : linhas
      const ultimo = pagina[pagina.length - 1]
      return reply.send({
        itens: pagina.map((l) => ({ id: l.id, nome: l.nome })),
        proximoCursor: temMais && ultimo ? Buffer.from(`${ultimo.nome}§${ultimo.id}`).toString('base64url') : null,
      })
    },
  )

  // Adicionar contato à lista (idempotente).
  app.post<{ Params: { id: string }; Body: { contatoId?: string } }>(
    '/v1/listas/:id/membros', { preHandler: exigirTenant },
    async (req, reply) => {
      const contatoId = req.body?.contatoId
      if (!contatoId) return reply.code(422).send({ erro: 'lista.contato_obrigatorio' })
      try {
        await req.comTenant(async (tx) => {
          const eu = await garantirUsuarioId(tx, req)
          await tx`INSERT INTO lista_membro (tenant_id, lista_id, contato_id, adicionado_por)
                   VALUES (tenant_atual(), ${req.params.id}, ${contatoId}, ${eu})
                   ON CONFLICT (tenant_id, lista_id, contato_id) DO NOTHING`
        })
        return reply.code(201).send({ ok: true })
      } catch (e) {
        // FK: lista ou contato inexistente neste tenant.
        if (e instanceof Error && e.message.includes('lista_membro_tenant_id_lista_id_fkey')) {
          return reply.code(404).send({ erro: 'lista.nao_encontrada' })
        }
        if (e instanceof Error && e.message.includes('lista_membro_tenant_id_contato_id_fkey')) {
          return reply.code(422).send({ erro: 'lista.contato_invalido' })
        }
        throw e
      }
    },
  )

  // Remover contato da lista.
  app.delete<{ Params: { id: string; contatoId: string } }>(
    '/v1/listas/:id/membros/:contatoId', { preHandler: exigirTenant },
    async (req, reply) => {
      const [r] = await req.comTenant((tx) => tx`
        DELETE FROM lista_membro
         WHERE tenant_id = tenant_atual() AND lista_id = ${req.params.id} AND contato_id = ${req.params.contatoId}
         RETURNING contato_id`)
      if (!r) return reply.code(404).send({ erro: 'lista.membro_nao_encontrado' })
      return reply.send({ ok: true })
    },
  )
}
