import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { exigirStaff, exigirTenant } from '../../plugins/tenant.js'
import { comTenantServico } from '../../db/index.js'
import { catalogoComPermissao, definirPermitidos } from '../atendimento/agente/modelos.js'

/**
 * Staff da Gera3 decide QUAIS modelos do catálogo cada cliente pode escolher
 * (docs/estudo-modelos-llm.md §3). O cliente escolhe o modelo; a chave é nossa.
 */
const UUID = /^[0-9a-f-]{36}$/i
const corpo = z.object({ codigos: z.array(z.string().trim().min(1).max(60)).max(100) })

export async function rotasModelosIa(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>(
    '/v1/plataforma/clientes/:id/modelos', { preHandler: [exigirTenant, exigirStaff] },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return reply.code(422).send({ erro: 'cliente.id_invalido' })
      const itens = await comTenantServico(req.params.id, (tx) => catalogoComPermissao(tx))
      return reply.send({ itens })
    },
  )
  app.put<{ Params: { id: string }; Body: unknown }>(
    '/v1/plataforma/clientes/:id/modelos', { preHandler: [exigirTenant, exigirStaff] },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return reply.code(422).send({ erro: 'cliente.id_invalido' })
      const p = corpo.safeParse(req.body)
      if (!p.success) return reply.code(422).send({ erro: 'modelos.corpo_invalido', mensagem: 'Envie { codigos: string[] }.' })
      const r = await comTenantServico(req.params.id, (tx) => definirPermitidos(tx, p.data.codigos))
      if (r.desconhecidos.length) return reply.code(422).send({ erro: 'modelos.codigo_desconhecido', mensagem: `Modelo(s) fora do catálogo: ${r.desconhecidos.join(', ')}`, campos: ['codigos'] })
      return reply.send({ ok: true, permitidos: r.permitidos })
    },
  )
}
