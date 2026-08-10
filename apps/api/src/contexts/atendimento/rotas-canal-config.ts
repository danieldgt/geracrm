import type { FastifyInstance } from 'fastify'
import { exigirTenant } from '../../plugins/tenant.js'

/**
 * Configuração por canal (0011): horário de atendimento, mensagem de ausência,
 * assinatura e a PAUSA de disparo. Uma linha por canal; sem linha = defaults.
 *
 * ⚠️ A pausa tem invariante no banco (canal_pausa_coerente): pausado exige motivo
 * e data; retomar zera os três. Tenant sempre de tenant_atual() (ADR-001).
 * ⚠️ jsonb via ::text::jsonb (evita a dupla-serialização do postgres.js).
 */
export async function rotasCanalConfig(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>(
    '/v1/canais/:id/config', { preHandler: exigirTenant },
    async (req, reply) => {
      const dados = await req.comTenant(async (tx) => {
        const [canal] = await tx<{ nome: string }[]>`
          SELECT nome_amigavel AS nome FROM canal_conectado WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        if (!canal) return null
        const [cfg] = await tx<{
          horario_atendimento: unknown; mensagem_ausencia: string | null; assinatura: string | null
          disparo_pausado: boolean; pausado_motivo: string | null; pausado_em: Date | null
        }[]>`
          SELECT horario_atendimento, mensagem_ausencia, assinatura, disparo_pausado, pausado_motivo, pausado_em
            FROM canal_configuracao WHERE tenant_id = tenant_atual() AND canal_id = ${req.params.id}`
        return { canal, cfg }
      })
      if (!dados) return reply.code(404).send({ erro: 'canal.nao_encontrado' })
      const c = dados.cfg
      return reply.send({
        canal: dados.canal.nome,
        horarioAtendimento: c?.horario_atendimento ?? {},
        mensagemAusencia: c?.mensagem_ausencia ?? null,
        assinatura: c?.assinatura ?? null,
        disparoPausado: c?.disparo_pausado ?? false,
        pausadoMotivo: c?.pausado_motivo ?? null,
        pausadoEm: c?.pausado_em ?? null,
      })
    },
  )

  // Salvar a configuração (horário, ausência, assinatura). Não mexe na pausa.
  app.put<{ Params: { id: string }; Body: { horarioAtendimento?: unknown; mensagemAusencia?: string; assinatura?: string } }>(
    '/v1/canais/:id/config', { preHandler: exigirTenant },
    async (req, reply) => {
      const horario = req.body?.horarioAtendimento
      if (horario !== undefined && (typeof horario !== 'object' || horario === null || Array.isArray(horario))) {
        return reply.code(422).send({ erro: 'canal.horario_invalido', mensagem: 'Horário deve ser um objeto por dia.' })
      }
      const r = await req.comTenant(async (tx) => {
        const [canal] = await tx<{ id: string }[]>`
          SELECT id FROM canal_conectado WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        if (!canal) return null
        await tx`
          INSERT INTO canal_configuracao (tenant_id, canal_id, horario_atendimento, mensagem_ausencia, assinatura)
          VALUES (tenant_atual(), ${req.params.id}, ${JSON.stringify(horario ?? {})}::text::jsonb,
                  ${req.body?.mensagemAusencia?.trim() || null}, ${req.body?.assinatura?.trim() || null})
          ON CONFLICT (tenant_id, canal_id) DO UPDATE SET
            horario_atendimento = EXCLUDED.horario_atendimento,
            mensagem_ausencia   = EXCLUDED.mensagem_ausencia,
            assinatura          = EXCLUDED.assinatura`
        return canal
      })
      if (!r) return reply.code(404).send({ erro: 'canal.nao_encontrado' })
      return reply.send({ ok: true })
    },
  )

  // Pausar o disparo do canal (exige motivo — invariante do banco).
  app.post<{ Params: { id: string }; Body: { motivo?: string } }>(
    '/v1/canais/:id/config/pausar', { preHandler: exigirTenant },
    async (req, reply) => {
      const motivo = req.body?.motivo?.trim()
      if (!motivo) return reply.code(422).send({ erro: 'canal.motivo_obrigatorio', mensagem: 'Diga por que está pausando.' })
      const r = await req.comTenant(async (tx) => {
        const [canal] = await tx<{ id: string }[]>`
          SELECT id FROM canal_conectado WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        if (!canal) return null
        await tx`
          INSERT INTO canal_configuracao (tenant_id, canal_id, disparo_pausado, pausado_motivo, pausado_em)
          VALUES (tenant_atual(), ${req.params.id}, true, ${motivo}, now())
          ON CONFLICT (tenant_id, canal_id) DO UPDATE SET
            disparo_pausado = true, pausado_motivo = ${motivo}, pausado_em = now()`
        return canal
      })
      if (!r) return reply.code(404).send({ erro: 'canal.nao_encontrado' })
      return reply.send({ ok: true })
    },
  )

  // Retomar o disparo (zera os três campos, satisfazendo o CHECK).
  app.post<{ Params: { id: string } }>(
    '/v1/canais/:id/config/retomar', { preHandler: exigirTenant },
    async (req, reply) => {
      const [r] = await req.comTenant((tx) => tx`
        UPDATE canal_configuracao
           SET disparo_pausado = false, pausado_motivo = NULL, pausado_em = NULL
         WHERE tenant_id = tenant_atual() AND canal_id = ${req.params.id} RETURNING canal_id`)
      // Sem linha = já não estava pausado; idempotente.
      return reply.send({ ok: true, jaAtivo: !r })
    },
  )
}
