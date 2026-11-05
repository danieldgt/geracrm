import type { FastifyInstance } from 'fastify'
import type { ResumoObjecoesDto } from '@geracrm/shared'
import { exigirTenant } from '../../../plugins/tenant.js'
import { janelaDoResumo, resumoDasObjecoes } from './objecoes.js'

/**
 * OBJEÇÕES — relatório mínimo da aba Métricas do agente (raia G2).
 *
 *   GET /v1/agente/objecoes/resumo?dias=30&canalId=   por código: objeção, vezes, revertidas, % revertida
 *
 * `canalId` ausente = a conta inteira; inválido = 404 (nunca cai na conta).
 * `dias` 1–90 (padrão 30). Leitura sob RLS, com a mesma permissão de
 * `/v1/agente/metricas`. Agregado limitado por construção (≤ 99 códigos).
 */

const UUID = /^[0-9a-f-]{36}$/i

export async function rotasObjecoes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { dias?: string; canalId?: string } }>(
    '/v1/agente/objecoes/resumo', { preHandler: exigirTenant },
    async (req, reply) => {
      const bruto = req.query.canalId
      if (bruto !== undefined && bruto !== '' && !UUID.test(bruto)) return reply.code(404).send({ erro: 'canal.nao_encontrado' })
      const canalId = bruto ? bruto : null
      const dias = janelaDoResumo(req.query.dias)
      const itens = await req.comTenant(async (tx) => {
        if (canalId) {
          const [c] = await tx<{ id: string }[]>`SELECT id FROM canal_conectado WHERE tenant_id = tenant_atual() AND id = ${canalId}`
          if (!c) return null
        }
        return resumoDasObjecoes(tx, { dias, canalId, agora: new Date() })
      })
      if (!itens) return reply.code(404).send({ erro: 'canal.nao_encontrado' })
      const corpo: ResumoObjecoesDto = { dias, canalId, itens }
      return reply.send(corpo)
    },
  )
}
