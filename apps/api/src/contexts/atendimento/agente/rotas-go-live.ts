import type { FastifyInstance, FastifyRequest } from 'fastify'
import { exigirTenant } from '../../../plugins/tenant.js'
import { exigirPapel } from '../../plataforma/papel.js'
import { garantirUsuarioId } from '../rotas-fila.js'
import { coletarGoLive } from './go-live.js'

/**
 * PAINEL E CRITÉRIO DE FASE (go-live) — raia P19 (docs/plano-port-playbook-am.md, ADR-031).
 *
 *   GET /v1/agente/go-live?canalId → GoLiveDto (shared agente-fases.ts):
 *     {fase, rotuloFase, dias, diasUteis, inicioFase, inicioEstimado, janelaDias, modoAgora,
 *      criterios[{id, rotulo, alvo, valor, ok, fonte, indisponivel?, motivo?}],
 *      podeAvancar, proximaFase, recomendacao, voltarPara, pendencias, alvosProposta}
 *
 * ⚠️ Só LEITURA: o painel não muda o modo (tela da P14, com confirmação).
 * ⚠️ Gestor ou admin — mesma régua da revisão humana (P16), de onde vem a concordância.
 * ⚠️ Tenant do token (RLS); `canalId` só escolhe o número dentro do tenant.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function garantirUsuario(req: FastifyRequest): Promise<void> {
  if (req.tenantId) await req.comTenant((tx) => garantirUsuarioId(tx, req))
}

export async function rotasGoLive(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { canalId?: string } }>(
    '/v1/agente/go-live', { preHandler: [exigirTenant, garantirUsuario, exigirPapel('admin', 'gestor')] },
    async (req, reply) => {
      const canalId = req.query.canalId
      if (!canalId || !UUID.test(canalId)) {
        return reply.code(422).send({ erro: 'go_live.campo_invalido', mensagem: 'canalId: informe o número (UUID).', campos: ['canalId'] })
      }
      const r = await req.comTenant((tx) => coletarGoLive(tx, { canalId, agora: new Date() }))
      if (!r) return reply.code(404).send({ erro: 'canal.nao_encontrado' })
      return reply.send(r)
    },
  )
}
