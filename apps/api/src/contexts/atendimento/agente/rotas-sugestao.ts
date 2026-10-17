import type { FastifyInstance } from 'fastify'
import { descartarSugestaoEntrada, type RespostaSugestao } from '@geracrm/shared'
import { exigirTenant } from '../../../plugins/tenant.js'
import { auditar } from '../../plataforma/auditoria.js'
import { garantirUsuarioId } from '../rotas-fila.js'
import {
  descartarSugestao, gerarCopiloto, lerSugestaoVigente, metricasSugestoes, modoParaCopiloto, publicarSugestaoMudou,
  type OpcoesCopiloto,
} from './sugestao.js'

/**
 * SUGESTÃO DO ASSISTIDO E COPILOTO — rotas do vendedor no inbox (raia P13).
 *
 *   GET  /v1/conversas/:id/sugestao            sugestão vigente + selo do modo + se o copiloto pode rodar
 *   POST /v1/conversas/:id/sugestao/gerar      copiloto sob demanda (só leitura, 20 s, 502 copiloto.indisponivel)
 *   POST /v1/agente/sugestoes/:decisaoId/descartar
 *   GET  /v1/agente/sugestoes/metricas         uso, sem edição, descarte, CRÍTICA, sombra × humano (do banco)
 *
 * O envio com `sugestaoDecisaoId` mora em `rotas-mensagens.ts` (mesma rota de envio do inbox).
 * Tempo real: `agente.sugestao` pelo outbox, payload só com ids — a tela busca aqui, sob RLS.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const MENSAGEM_SEM_SUGESTAO: Record<string, string> = {
  orcamento_do_dia: 'O teto diário de custo do agente deste número foi atingido. Responda sem a sugestão.',
}

export async function rotasSugestao(app: FastifyInstance, opcoes: { copiloto?: OpcoesCopiloto } = {}): Promise<void> {
  app.get<{ Params: { id: string } }>(
    '/v1/conversas/:id/sugestao', { preHandler: exigirTenant },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'conversa.nao_encontrada' })
      const r = await req.comTenant(async (tx) => {
        const [c] = await tx<{ canal_id: string }[]>`
          SELECT canal_id FROM conversa WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        if (!c) return null
        const modo = await modoParaCopiloto(tx, c.canal_id)
        const corpo: RespostaSugestao = {
          sugestao: await lerSugestaoVigente(tx, req.params.id),
          modoAgente: modo,
          copilotoDisponivel: modo !== null && modo !== 'desligado',
          motivoIndisponivel: modo === null ? 'agente.sem_configuracao' : modo === 'desligado' ? 'agente.desligado' : null,
        }
        return corpo
      })
      if (!r) return reply.code(404).send({ erro: 'conversa.nao_encontrada' })
      return reply.send(r)
    },
  )

  app.post<{ Params: { id: string } }>(
    '/v1/conversas/:id/sugestao/gerar', { preHandler: exigirTenant },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'conversa.nao_encontrada' })
      const r = await gerarCopiloto(req.tenantId!, req.params.id, opcoes.copiloto)
      switch (r.tipo) {
        case 'ok': return reply.send({ sugestao: r.sugestao })
        case 'conversa_inexistente': return reply.code(404).send({ erro: 'conversa.nao_encontrada' })
        case 'sem_configuracao':
          return reply.code(409).send({ erro: 'agente.sem_configuracao', mensagem: 'O agente deste número não está configurado — configure em Agente para pedir sugestões.' })
        case 'desligado':
          return reply.code(409).send({ erro: 'agente.desligado', mensagem: 'Agente desligado — sugestão indisponível.' })
        case 'em_andamento':
          return reply.code(409).send({ erro: 'copiloto.em_andamento', mensagem: 'Já estou preparando uma sugestão para esta conversa.' })
        case 'sem_sugestao':
          return reply.code(409).send({
            erro: 'copiloto.sem_sugestao', motivo: r.motivo, resumo: r.resumo,
            mensagem: MENSAGEM_SEM_SUGESTAO[r.motivo] ?? 'O assistente não tem uma sugestão para esta conversa — responda você mesmo.',
          })
        case 'indisponivel':
          req.log.warn({ conversaId: req.params.id, detalhe: r.detalhe }, 'copiloto indisponivel')
          return reply.code(502).send({
            erro: 'copiloto.indisponivel',
            mensagem: 'O assistente não respondeu a tempo. Tente de novo ou responda sem a sugestão.',
          })
      }
    },
  )

  app.post<{ Params: { decisaoId: string } }>(
    '/v1/agente/sugestoes/:decisaoId/descartar', { preHandler: exigirTenant },
    async (req, reply) => {
      if (!UUID.test(req.params.decisaoId)) return reply.code(404).send({ erro: 'sugestao.nao_encontrada' })
      const corpo = descartarSugestaoEntrada.safeParse(req.body ?? {})
      if (!corpo.success) return reply.code(422).send({ erro: 'sugestao.invalida', mensagem: 'Motivo inválido (até 200 caracteres).' })
      const r = await req.comTenant(async (tx) => {
        const d = await descartarSugestao(tx, req.params.decisaoId, new Date())
        if (!d.ok) return d
        await publicarSugestaoMudou(tx, d.conversaId, req.params.decisaoId)
        await auditar(tx, {
          atorId: await garantirUsuarioId(tx, req), acao: 'agente.sugestao_descartada', entidade: 'agente_decisao',
          entidadeId: req.params.decisaoId, ...(corpo.data.motivo ? { dados: { motivo: corpo.data.motivo } } : {}),
        })
        return d
      })
      if (r.ok) return reply.send({ ok: true })
      if (r.motivo === 'nao_encontrada') return reply.code(404).send({ erro: 'sugestao.nao_encontrada' })
      return reply.code(409).send({ erro: 'sugestao.ja_decidida', estado: r.estado ?? null, mensagem: 'Esta sugestão já foi usada ou descartada.' })
    },
  )

  app.get<{ Querystring: { dias?: string; canalId?: string } }>(
    '/v1/agente/sugestoes/metricas', { preHandler: exigirTenant },
    async (req, reply) => {
      const dias = Math.min(Math.max(Number(req.query.dias) || 7, 1), 90)
      const canalId = req.query.canalId && UUID.test(req.query.canalId) ? req.query.canalId : null
      return reply.send(await req.comTenant((tx) => metricasSugestoes(tx, dias, canalId)))
    },
  )
}
