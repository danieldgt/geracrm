import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { ConfigAgendaDoAgente } from '@geracrm/shared'
import { exigirTenant } from '../../../plugins/tenant.js'
import { exigirPapel } from '../../plataforma/papel.js'
import { exigirModulo } from '../../plataforma/modulos.js'
import { auditar } from '../../plataforma/auditoria.js'
import { atorDaRequisicao, garantirUsuarioId } from '../rotas-fila.js'
import { travarPlaybookDoTenant } from './playbook/repositorio.js'
import { lerTemplate } from './ativas.js'

/**
 * "O AGENTE PODE MARCAR REUNIÕES" — a chave POR NÚMERO da raia C3 (0137), mais os templates
 * dos avisos ao cliente no oficial fora da janela (lembrete e convite para remarcar).
 *
 *   GET/PUT /v1/canais/:id/agente/agenda
 *
 * ⚠️ Atrás do módulo Agenda (404 desligado): a tela só mostra a chave com o módulo ligado.
 * ⚠️ Padrão DESLIGADO (decisão do dono). Desligada, `agendar_reuniao` não entra no turno;
 *    o botão "Agendar reunião" do inbox continua valendo para a pessoa.
 * ⚠️ Escrita exige admin e deixa auditoria `agente.config_alterada` com antes/depois.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const corpo = z.object({
  reunioes: z.boolean(),
  templateLembreteId: z.string().regex(UUID).nullable(),
  templateReagendarId: z.string().regex(UUID).nullable(),
}).strict()

async function garantirUsuario(req: FastifyRequest): Promise<void> {
  if (req.tenantId && !req.atorStaff) await req.comTenant((tx) => garantirUsuarioId(tx, req))
}

interface Linha { reunioes: boolean | null; lembrete: string | null; reagendar: string | null; modo: string | null }
const paraConfig = (l: Linha | undefined): ConfigAgendaDoAgente => ({
  reunioes: l?.reunioes ?? false, templateLembreteId: l?.lembrete ?? null, templateReagendarId: l?.reagendar ?? null,
})

export async function rotasAgendaAgente(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>(
    '/v1/canais/:id/agente/agenda', { preHandler: [exigirTenant, exigirModulo('agenda')] },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'canal.nao_encontrado' })
      const r = await req.comTenant(async (tx) => {
        const [canal] = await tx<{ tipo: string }[]>`SELECT tipo FROM canal_conectado WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        if (!canal) return null
        const [l] = await tx<Linha[]>`
          SELECT agenda_reunioes AS reunioes, agenda_template_lembrete AS lembrete, agenda_template_reagendar AS reagendar, modo
            FROM agente_config WHERE tenant_id = tenant_atual() AND canal_id = ${req.params.id}`
        return { tipoCanal: canal.tipo, l }
      })
      if (!r) return reply.code(404).send({ erro: 'canal.nao_encontrado' })
      // `modoDoNumero` deixa a tela explicar que em sombra/desligado a chave ainda não tem efeito.
      return reply.send({ ...paraConfig(r.l), modoDoNumero: r.l?.modo ?? 'desligado', tipoCanal: r.tipoCanal })
    },
  )

  app.put<{ Params: { id: string }; Body: unknown }>(
    '/v1/canais/:id/agente/agenda', { preHandler: [exigirTenant, exigirModulo('agenda'), garantirUsuario, exigirPapel('admin')] },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'canal.nao_encontrado' })
      const p = corpo.safeParse(req.body ?? {})
      if (!p.success) {
        const i = p.error.issues[0]!
        return reply.code(422).send({ erro: 'agenda.campo_invalido', mensagem: `${i.path.join('.') || 'corpo'}: ${i.message}`, campos: [i.path.join('.')] })
      }
      const novo = p.data
      const r = await req.comTenant(async (tx) => {
        // Ordem canônica de locks (P17): a trava do playbook do tenant ANTES de tocar agente_config.
        await travarPlaybookDoTenant(tx)
        const [canal] = await tx`SELECT 1 FROM canal_conectado WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        if (!canal) return 'canal' as const
        for (const [campo, id] of [['templateLembreteId', novo.templateLembreteId], ['templateReagendarId', novo.templateReagendarId]] as const) {
          if (!id) continue
          // B4: só template APROVADO e compatível (no máximo {{1}} = primeiro nome) — o mesmo que o envio aceita.
          const [existe] = await tx`SELECT 1 FROM template WHERE tenant_id = tenant_atual() AND id = ${id}`
          const t = existe ? await lerTemplate(tx, id) : null
          if (!t) return { campo, mensagem: 'Template não encontrado.' }
          if (t.status !== 'APPROVED') return { campo, mensagem: 'Este template ainda não está aprovado pela Meta.' }
          if (!t.compativel) return { campo, mensagem: 'O template usa variável além do primeiro nome ({{1}}); o aviso não tem como preenchê-la.' }
        }
        const [antes] = await tx<Linha[]>`
          SELECT agenda_reunioes AS reunioes, agenda_template_lembrete AS lembrete, agenda_template_reagendar AS reagendar, modo
            FROM agente_config WHERE tenant_id = tenant_atual() AND canal_id = ${req.params.id}`
        // Número sem configuração ainda: nasce com os padrões da tabela (desligado), só com a agenda.
        await tx`
          INSERT INTO agente_config (tenant_id, canal_id, agenda_reunioes, agenda_template_lembrete, agenda_template_reagendar, atualizado_em)
          VALUES (tenant_atual(), ${req.params.id}, ${novo.reunioes}, ${novo.templateLembreteId}, ${novo.templateReagendarId}, now())
          ON CONFLICT (tenant_id, canal_id) DO UPDATE SET
            agenda_reunioes = EXCLUDED.agenda_reunioes, agenda_template_lembrete = EXCLUDED.agenda_template_lembrete,
            agenda_template_reagendar = EXCLUDED.agenda_template_reagendar, atualizado_em = now()`
        await auditar(tx, {
          atorId: await atorDaRequisicao(tx, req), atorStaff: req.atorStaff ?? false,
          acao: 'agente.config_alterada', entidade: 'agente_config', entidadeId: req.params.id,
          dados: { campo: 'agenda', antes: paraConfig(antes), depois: novo },
        })
        return 'ok' as const
      })
      if (r === 'canal') return reply.code(404).send({ erro: 'canal.nao_encontrado' })
      if (r !== 'ok') return reply.code(422).send({ erro: 'agenda.template_invalido', mensagem: r.mensagem, campos: { [r.campo]: r.mensagem } })
      return reply.send({ ok: true, ...novo })
    },
  )
}
