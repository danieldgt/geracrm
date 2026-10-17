import type { FastifyInstance } from 'fastify'
import {
  BASE_B2B_DESCRITA, LIMITES_COMPLIANCE, complianceExtraCompleto, lerComplianceExtra, semDuplicatas, type ComplianceExtra,
} from '@geracrm/shared'
import { exigirTenant } from '../../../plugins/tenant.js'
import { exigirPapel, temPapel } from '../../plataforma/papel.js'
import { auditar } from '../../plataforma/auditoria.js'
import { garantirUsuarioId } from '../rotas-fila.js'

/**
 * COMPLIANCE DO AGENTE POR NÚMERO (raia P2; ADR-029 §5, ADR-033).
 *
 * Frases proibidas e gatilhos de handoff EXTRAS — texto literal, só
 * ACRESCENTAM à base do código (`PROIBIDAS_BASE_B2B`), que não aparece aqui
 * como editável: a tela mostra a base para quem configura saber o que já vale
 * sempre, mas não tem como desligá-la.
 *
 *   GET /v1/canais/:id/agente/compliance  → { frasesProibidas, gatilhosHandoff, base, limites, podeEditar }
 *   PUT /v1/canais/:id/agente/compliance  ← { frasesProibidas, gatilhosHandoff }  (admin; auditoria {antes, depois})
 *
 * O turno lê a coluna a cada execução (`lerConfig` → `cfgExtra.compliance`):
 * o que for gravado vale no turno seguinte, sem cache.
 */

const UUID = /^[0-9a-f-]{36}$/i

/** Nome do campo como a tela o mostra (a 422 fala a língua de quem configura). */
const ROTULO_CAMPO: Readonly<Record<string, string>> = {
  frasesProibidas: 'Frases proibidas extras',
  gatilhosHandoff: 'Gatilhos de transferência extras',
  corpo: 'Pedido',
}

export async function rotasCompliance(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>(
    '/v1/canais/:id/agente/compliance', { preHandler: exigirTenant },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'canal.nao_encontrado' })
      const lido = await req.comTenant(async (tx) => {
        const [canal] = await tx<{ compliance: unknown }[]>`
          SELECT ac.compliance
            FROM canal_conectado c
            LEFT JOIN agente_config ac ON ac.tenant_id = c.tenant_id AND ac.canal_id = c.id
           WHERE c.tenant_id = tenant_atual() AND c.id = ${req.params.id}`
        return canal ?? null
      })
      if (!lido) return reply.code(404).send({ erro: 'canal.nao_encontrado' })
      return reply.send({
        ...lerComplianceExtra(lido.compliance),
        base: BASE_B2B_DESCRITA,
        limites: LIMITES_COMPLIANCE,
        podeEditar: await temPapel(req, 'admin'),
      })
    },
  )

  app.put<{ Params: { id: string }; Body: unknown }>(
    '/v1/canais/:id/agente/compliance', { preHandler: [exigirTenant, exigirPapel('admin')] },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'canal.nao_encontrado' })
      // ⚠️ Os DOIS campos são obrigatórios: corpo parcial não apaga a outra lista por default.
      const parse = complianceExtraCompleto.safeParse(req.body ?? {})
      if (!parse.success) {
        const i = parse.error.issues[0]!
        const campo = typeof i.path[0] === 'string' && i.path[0] in ROTULO_CAMPO ? i.path[0] : 'corpo'
        const item = typeof i.path[1] === 'number' ? ` (item ${i.path[1] + 1})` : ''
        const motivo = i.code === 'unrecognized_keys' ? 'só são aceitas as frases proibidas e os gatilhos de transferência.'
          : i.code === 'invalid_type' && i.path.length === 1 ? 'envie a lista (pode ser vazia).' : i.message
        return reply.code(422).send({ erro: 'compliance.campo_invalido', mensagem: `${ROTULO_CAMPO[campo]}${item}: ${motivo}`, campos: [campo] })
      }
      const depois: ComplianceExtra = {
        frasesProibidas: semDuplicatas(parse.data.frasesProibidas),
        gatilhosHandoff: semDuplicatas(parse.data.gatilhosHandoff),
      }
      const r = await req.comTenant(async (tx) => {
        const [canal] = await tx<{ id: string; compliance: unknown }[]>`
          SELECT c.id, ac.compliance
            FROM canal_conectado c
            LEFT JOIN agente_config ac ON ac.tenant_id = c.tenant_id AND ac.canal_id = c.id
           WHERE c.tenant_id = tenant_atual() AND c.id = ${req.params.id}
             FOR UPDATE OF c`
        if (!canal) return null
        const antes = lerComplianceExtra(canal.compliance)
        // Sem linha de configuração ainda: nasce com os padrões da tabela (modo desligado).
        await tx`
          INSERT INTO agente_config (tenant_id, canal_id, compliance, atualizado_em)
          VALUES (tenant_atual(), ${req.params.id}, ${JSON.stringify(depois)}::text::jsonb, now())
          ON CONFLICT (tenant_id, canal_id) DO UPDATE SET compliance = EXCLUDED.compliance, atualizado_em = now()`
        await auditar(tx, {
          atorId: req.atorStaff ? null : await garantirUsuarioId(tx, req),
          atorStaff: req.atorStaff ?? false,
          acao: 'agente.compliance_alterado', entidade: 'canal_conectado', entidadeId: req.params.id,
          dados: { antes, depois },
        })
        return { antes }
      })
      if (!r) return reply.code(404).send({ erro: 'canal.nao_encontrado' })
      return reply.send({ ok: true, ...depois })
    },
  )
}
