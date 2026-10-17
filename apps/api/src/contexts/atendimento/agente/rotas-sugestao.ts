import type { FastifyInstance } from 'fastify'
import { descartarSugestaoEntrada, type RespostaSugestao } from '@geracrm/shared'
import { exigirTenant } from '../../../plugins/tenant.js'
import { auditar } from '../../plataforma/auditoria.js'
import { garantirUsuarioId } from '../rotas-fila.js'
import {
  descartarSugestao, gerarCopiloto, lerConversaParaSugestao, lerSugestaoVigente, metricasSugestoes, modoDoCopiloto, publicarSugestaoMudou,
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
  // O copiloto respeita o teto diário do número (é o mesmo orçamento do agente).
  orcamento_do_dia: 'Limite diário de IA deste número atingido — responda sem a sugestão até amanhã.',
}

export async function rotasSugestao(app: FastifyInstance, opcoes: { copiloto?: OpcoesCopiloto } = {}): Promise<void> {
  app.get<{ Params: { id: string } }>(
    '/v1/conversas/:id/sugestao', { preHandler: exigirTenant },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'conversa.nao_encontrada' })
      const lido = await req.comTenant(async (tx) => {
        const conv = await lerConversaParaSugestao(tx, req.params.id)
        if (!conv) return null
        // "Sugestão pedida por <nome>" só quando quem pediu foi OUTRO vendedor.
        return { conv, sugestao: await lerSugestaoVigente(tx, req.params.id, await garantirUsuarioId(tx, req)) }
      })
      if (!lido) return reply.code(404).send({ erro: 'conversa.nao_encontrada' })
      // Selo = modo EFETIVO (P14: teto do tenant, número, recorte), o mesmo que decide o copiloto.
      const modo = await modoDoCopiloto(req.tenantId!, { ...lido.conv, agora: opcoes.copiloto?.agora ?? new Date() })
      const corpo: RespostaSugestao = {
        sugestao: lido.sugestao,
        modoAgente: modo,
        copilotoDisponivel: modo !== null && modo !== 'desligado',
        motivoIndisponivel: modo === null ? 'agente.sem_configuracao' : modo === 'desligado' ? 'agente.desligado' : null,
      }
      return reply.send(corpo)
    },
  )

  app.post<{ Params: { id: string } }>(
    '/v1/conversas/:id/sugestao/gerar', { preHandler: exigirTenant },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'conversa.nao_encontrada' })
      const eu = await req.comTenant((tx) => garantirUsuarioId(tx, req))
      const r = await gerarCopiloto(req.tenantId!, req.params.id, opcoes.copiloto, eu)
      switch (r.tipo) {
        case 'ok': return reply.send({ sugestao: r.sugestao })
        case 'conversa_inexistente': return reply.code(404).send({ erro: 'conversa.nao_encontrada' })
        case 'sem_configuracao':
          return reply.code(409).send({ erro: 'agente.sem_configuracao', mensagem: 'O agente deste número não está configurado — configure em Agente para pedir sugestões.' })
        case 'desligado':
          return reply.code(409).send({ erro: 'agente.desligado', mensagem: 'Agente desligado — sugestão indisponível.' })
        case 'em_andamento':
          return reply.code(409).send({ erro: 'copiloto.em_andamento', mensagem: 'Já estou preparando uma sugestão para esta conversa.' })
        case 'ocupado':
          return reply.code(503).header('retry-after', '5').send({
            erro: 'copiloto.ocupado', mensagem: 'O assistente está atendendo outros pedidos agora. Tente de novo em alguns segundos.',
          })
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
