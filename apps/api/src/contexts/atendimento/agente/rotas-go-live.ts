import type { FastifyInstance, FastifyRequest } from 'fastify'
import { corpoConferenciaGoLive } from '@geracrm/shared'
import { exigirTenant } from '../../../plugins/tenant.js'
import { exigirPapel } from '../../plataforma/papel.js'
import { auditar } from '../../plataforma/auditoria.js'
import { garantirUsuarioId } from '../rotas-fila.js'
import { coletarGoLive } from './go-live.js'
import { gravarConferencia } from './homologacao.js'

/**
 * PAINEL E CRITÉRIO DE FASE (go-live) — raia P19 (docs/plano-port-playbook-am.md, ADR-031).
 *
 *   GET  /v1/agente/go-live?canalId     → GoLiveDto (shared agente-fases.ts) — gestor ou admin, só leitura
 *   POST /v1/agente/go-live/conferencia → registra a última rodada das douradas ou do smoke — admin, auditado
 *
 * ⚠️ O painel não muda o modo (tela da P14, com confirmação).
 * ⚠️ Tenant do token (RLS); `canalId` só escolhe o número dentro do tenant.
 * ⚠️ A conferência guarda o que o admin DIGITOU (cenários, CRÍTICAs, ok) e quem
 *    digitou; vale 30 dias. O playground não se registra aqui: é medido nos
 *    reinícios da simulação.
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

  app.post(
    '/v1/agente/go-live/conferencia', { preHandler: [exigirTenant, garantirUsuario, exigirPapel('admin')] },
    async (req, reply) => {
      const p = corpoConferenciaGoLive.safeParse(req.body ?? {})
      if (!p.success) {
        const i = p.error.issues[0]!
        return reply.code(422).send({
          erro: 'go_live.campo_invalido', mensagem: `${i.path.join('.') || 'corpo'}: ${i.message}`, campos: p.error.issues.map((x) => x.path.join('.')),
        })
      }
      const c = p.data
      const resultado = c.item === 'douradas' ? { cenarios: c.cenarios, criticas: c.criticas } : { ok: c.ok }
      const r = await req.comTenant(async (tx) => {
        const [canal] = await tx<{ id: string }[]>`SELECT id FROM canal_conectado WHERE tenant_id = tenant_atual() AND id = ${c.canalId}`
        if (!canal) return null
        const eu = await garantirUsuarioId(tx, req)
        const g = await gravarConferencia(tx, { canalId: c.canalId, item: c.item, resultado, atorId: eu })
        await auditar(tx, {
          atorId: eu, atorStaff: req.atorStaff ?? false, acao: 'agente.go_live_conferencia', entidade: 'agente_homologacao',
          entidadeId: c.canalId, dados: { item: c.item, antes: g.antes, depois: resultado },
        })
        return g
      })
      if (!r) return reply.code(404).send({ erro: 'canal.nao_encontrado' })
      return reply.send({ item: c.item, resultado, atualizadoEm: r.atualizadoEm.toISOString() })
    },
  )
}
