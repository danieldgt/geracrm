import type { FastifyInstance } from 'fastify'
import { SLA_PADRAO, corpoSlaConfig, type CronometroSla, type EstadoSlaConfig } from '@geracrm/shared'
import { exigirTenant } from '../../plugins/tenant.js'
import { exigirPapel } from '../plataforma/papel.js'
import { auditar } from '../plataforma/auditoria.js'
import { fusoSeguro } from '../plataforma/fuso.js'
import { garantirUsuarioId } from './rotas-fila.js'
import { lerContextoSla, respostaHumanaDoAtendimento } from './sla-handoff.js'

/**
 * SLA DO HANDOFF (fatia de INB-22; raia P18, ADR-034).
 *
 *   GET /v1/canais/:id/sla      → EstadoSlaConfig (sem linha = padrão 30/60/ligado)
 *   PUT /v1/canais/:id/sla      → admin; auditado (`atendimento.sla_alterado`, antes/depois)
 *   GET /v1/conversas/:id/sla   → { cronometro: CronometroSla | null } do atendimento aberto
 *
 * ⚠️ O cronômetro devolve INSTANTES, não "faltam N min": a tela anda o relógio
 *    local a partir de `venceEm` (sem polling) e o evento `atendimento.mudou`
 *    (worker, assumir, resposta) diz quando buscar de novo.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function rotasSla(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>(
    '/v1/canais/:id/sla', { preHandler: exigirTenant },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'canal.nao_encontrado' })
      const estado = await req.comTenant(async (tx): Promise<EstadoSlaConfig | null> => {
        const ctx = await lerContextoSla(tx, req.params.id)
        if (!ctx) return null
        const [l] = await tx<{ atualizado_em: Date }[]>`
          SELECT atualizado_em FROM atendimento_sla_config WHERE tenant_id = tenant_atual() AND canal_id = ${req.params.id}`
        return {
          config: ctx.config, padrao: ctx.padrao, padroes: SLA_PADRAO, fuso: ctx.fuso,
          horarioConfigurado: !!ctx.horario && Object.keys(ctx.horario).length > 0,
          atualizadoEm: l?.atualizado_em.toISOString() ?? null,
        }
      })
      if (!estado) return reply.code(404).send({ erro: 'canal.nao_encontrado' })
      return estado
    },
  )

  app.put<{ Params: { id: string }; Body: unknown }>(
    '/v1/canais/:id/sla', { preHandler: [exigirTenant, exigirPapel('admin')] },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'canal.nao_encontrado' })
      const p = corpoSlaConfig.safeParse(req.body)
      if (!p.success) {
        return reply.code(422).send({
          erro: 'sla.invalido',
          mensagem: p.error.issues[0]?.message ?? 'Confira os minutos do SLA e da reatribuição.',
          campos: [...new Set(p.error.issues.map((i) => String(i.path[0] ?? '')))].filter(Boolean),
        })
      }
      const c = p.data
      const ok = await req.comTenant(async (tx) => {
        const antes = await lerContextoSla(tx, req.params.id)
        if (!antes) return false
        const atorId = await garantirUsuarioId(tx, req)
        await tx`
          INSERT INTO atendimento_sla_config (tenant_id, canal_id, sla_minutos, reatribuicao_minutos, aviso_espera, atualizado_em, atualizado_por)
          VALUES (tenant_atual(), ${req.params.id}, ${c.slaMinutos}, ${c.reatribuicaoMinutos}, ${c.avisoEspera}, now(), ${atorId})
          ON CONFLICT (tenant_id, canal_id) DO UPDATE
            SET sla_minutos = EXCLUDED.sla_minutos, reatribuicao_minutos = EXCLUDED.reatribuicao_minutos,
                aviso_espera = EXCLUDED.aviso_espera, atualizado_em = now(), atualizado_por = EXCLUDED.atualizado_por`
        await auditar(tx, {
          atorId, atorStaff: req.atorStaff === true, acao: 'atendimento.sla_alterado', entidade: 'canal_conectado',
          entidadeId: req.params.id, dados: { antes: { ...antes.config, padrao: antes.padrao }, depois: c },
        })
        return true
      })
      if (!ok) return reply.code(404).send({ erro: 'canal.nao_encontrado' })
      // ⚠️ Vale para os PRÓXIMOS handoffs: os prazos de quem já está na fila foram
      //    gravados na chegada e não mudam por baixo do cronômetro de ninguém.
      return { ok: true }
    },
  )

  app.get<{ Params: { id: string } }>(
    '/v1/conversas/:id/sla', { preHandler: exigirTenant },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'conversa.nao_encontrada' })
      const r = await req.comTenant(async (tx) => {
        const [conv] = await tx<{ id: string }[]>`SELECT id FROM conversa WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        if (!conv) return null
        const [a] = await tx<{
          id: string; sla_inicio_em: Date; sla_vence_em: Date; reatribuicao_vence_em: Date | null
          sla_estourado_em: Date | null; reatribuicao_liberada_em: Date | null; sla_respondido_em: Date | null
          respondido_em: Date | null; aviso_espera_em: Date | null; aviso_espera_resultado: string | null
          responsavel: string | null
        }[]>`
          SELECT a.id, a.sla_inicio_em, a.sla_vence_em, a.reatribuicao_vence_em, a.sla_estourado_em,
                 a.reatribuicao_liberada_em, a.sla_respondido_em, ${respostaHumanaDoAtendimento(tx)} AS respondido_em,
                 a.aviso_espera_em, a.aviso_espera_resultado, r.nome AS responsavel
            FROM atendimento a
            LEFT JOIN usuario r ON r.tenant_id = a.tenant_id AND r.id = a.responsavel_id
           WHERE a.tenant_id = tenant_atual() AND a.conversa_id = ${req.params.id}
             AND a.estado <> 'encerrado' AND a.sla_vence_em IS NOT NULL
           LIMIT 1`
        if (!a) return { cronometro: null }
        const [t] = await tx<{ fuso: string | null }[]>`SELECT fuso FROM tenant WHERE id = tenant_atual()`
        // A resposta humana vale na hora (o worker grava `sla_respondido_em` em até 30 s).
        const respondido = a.sla_respondido_em ?? a.respondido_em
        const cronometro: CronometroSla = {
          atendimentoId: a.id, inicioEm: a.sla_inicio_em.toISOString(), venceEm: a.sla_vence_em.toISOString(),
          reatribuicaoVenceEm: a.reatribuicao_vence_em?.toISOString() ?? null,
          estouradoEm: a.sla_estourado_em?.toISOString() ?? null,
          reatribuicaoLiberadaEm: a.reatribuicao_liberada_em?.toISOString() ?? null,
          respondidoEm: respondido?.toISOString() ?? null,
          avisoEspera: a.aviso_espera_em ? { em: a.aviso_espera_em.toISOString(), resultado: a.aviso_espera_resultado } : null,
          responsavel: a.responsavel, fuso: fusoSeguro(t?.fuso),
        }
        return { cronometro }
      })
      if (!r) return reply.code(404).send({ erro: 'conversa.nao_encontrada' })
      return r
    },
  )
}
