import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { z } from 'zod'
import {
  META_CONCORDANCIA, MIN_REVISADAS_CONCORDANCIA, SEMANA_RE, corpoRevisao,
  type AmostraRevisaoDto, type ConcordanciaDto,
} from '@geracrm/shared'
import { exigirTenant } from '../../../plugins/tenant.js'
import { exigirPapel } from '../../plataforma/papel.js'
import { garantirUsuarioId } from '../rotas-fila.js'
import { concordancia, detalheParaRevisar, gravarRevisao, itensDaAmostra, planilhaDaSemana, semanaDaLoja } from './revisao-humana.js'
import { celulaCsv } from './rotas-qualidade.js'

/**
 * REVISÃO HUMANA E CONCORDÂNCIA (ADR-031 §5, raia P16). Gestor ou admin.
 *
 *   GET  /v1/agente/revisao/amostra?canalId&semana     — as 20 conversas do número na ordem da P12, com "revisada ou não"
 *   GET  /v1/agente/revisao/planilha.csv?canalId&semana — a planilha da semana (amostra × revisor, notas e concordância), mascarada
 *   GET  /v1/agente/revisao/avaliacoes/:id             — transcrição mascarada (em sombra, a SUGESTÃO), notas do juiz, violações
 *   POST /v1/agente/revisao                            — grava (ou regrava) a revisão do revisor; concordância congelada
 *   GET  /v1/agente/revisao/concordancia?semana&canalId — {revisadas, concordancia, porCriterio, …, porNumero}
 *
 * ⚠️ Tenant e revisor vêm do token (RLS + `garantirUsuarioId`), nunca do corpo.
 * ⚠️ A amostra é limitada a 20 por número por construção (não há página seguinte).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function garantirUsuario(req: FastifyRequest): Promise<void> {
  if (req.tenantId) await req.comTenant((tx) => garantirUsuarioId(tx, req))
}

const GESTOR = [exigirTenant, garantirUsuario, exigirPapel('admin', 'gestor')]

function invalido(reply: FastifyReply, e: z.ZodError): FastifyReply {
  const i = e.issues[0]!
  return reply.code(422).send({ erro: 'revisao.campo_invalido', mensagem: `${i.path.join('.') || 'corpo'}: ${i.message}`, campos: e.issues.map((x) => x.path.join('.')) })
}

function semanaInvalida(reply: FastifyReply): FastifyReply {
  return reply.code(422).send({ erro: 'revisao.campo_invalido', mensagem: 'semana: use AAAA-Www (ex.: 2026-W42).', campos: ['semana'] })
}

export async function rotasRevisao(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { canalId?: string; semana?: string; cursor?: string } }>(
    '/v1/agente/revisao/amostra', { preHandler: GESTOR },
    async (req, reply) => {
      const { canalId, semana } = req.query
      if (!canalId || !UUID.test(canalId)) return reply.code(422).send({ erro: 'revisao.campo_invalido', mensagem: 'canalId: obrigatório.', campos: ['canalId'] })
      if (semana !== undefined && !SEMANA_RE.test(semana)) return semanaInvalida(reply)
      const r = await req.comTenant(async (tx) => {
        const s = await semanaDaLoja(tx, semana)
        if (!s) return 'semana_invalida' as const
        const [canal] = await tx<{ id: string }[]>`SELECT id FROM canal_conectado WHERE tenant_id = tenant_atual() AND id = ${canalId}`
        if (!canal) return 'sem_canal' as const
        const revisorId = await garantirUsuarioId(tx, req)
        return { s, itens: await itensDaAmostra(tx, canalId, s, revisorId) }
      })
      if (r === 'semana_invalida') return semanaInvalida(reply)
      if (r === 'sem_canal') return reply.code(404).send({ erro: 'canal.nao_encontrado' })
      const corpo: AmostraRevisaoDto = { semana: r.s.semana, inicio: r.s.inicio, canalId, itens: r.itens, proximoCursor: null }
      return reply.send(corpo)
    },
  )

  app.get<{ Querystring: { canalId?: string; semana?: string } }>(
    '/v1/agente/revisao/planilha.csv', { preHandler: GESTOR },
    async (req, reply) => {
      const { canalId, semana } = req.query
      if (!canalId || !UUID.test(canalId)) return reply.code(422).send({ erro: 'revisao.campo_invalido', mensagem: 'canalId: obrigatório.', campos: ['canalId'] })
      if (semana !== undefined && !SEMANA_RE.test(semana)) return semanaInvalida(reply)
      const r = await req.comTenant(async (tx) => {
        const s = await semanaDaLoja(tx, semana)
        if (!s) return 'semana_invalida' as const
        const [canal] = await tx<{ id: string }[]>`SELECT id FROM canal_conectado WHERE tenant_id = tenant_atual() AND id = ${canalId}`
        if (!canal) return 'sem_canal' as const
        return { s, p: await planilhaDaSemana(tx, canalId, s, await garantirUsuarioId(tx, req)) }
      })
      if (r === 'semana_invalida') return semanaInvalida(reply)
      if (r === 'sem_canal') return reply.code(404).send({ erro: 'canal.nao_encontrado' })
      const texto = [r.p.cabecalho.join(';'), ...r.p.linhas.map((l) => l.map(celulaCsv).join(';'))].join('\r\n')
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="revisao-${r.s.semana}.csv"`)
        .header('cache-control', 'no-store')
        .send(`﻿${texto}\r\n`)
    },
  )

  app.get<{ Params: { id: string } }>('/v1/agente/revisao/avaliacoes/:id', { preHandler: GESTOR }, async (req, reply) => {
    if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'revisao.avaliacao_nao_encontrada' })
    const d = await req.comTenant(async (tx) => detalheParaRevisar(tx, req.params.id, await garantirUsuarioId(tx, req)))
    if (!d) return reply.code(404).send({ erro: 'revisao.avaliacao_nao_encontrada' })
    return reply.send(d)
  })

  app.post<{ Body: unknown }>('/v1/agente/revisao', { preHandler: GESTOR }, async (req, reply) => {
    const p = corpoRevisao.safeParse(req.body ?? {})
    if (!p.success) return invalido(reply, p.error)
    const r = await req.comTenant(async (tx) => gravarRevisao(tx, p.data, await garantirUsuarioId(tx, req)))
    if (r.tipo === 'nao_encontrada') return reply.code(404).send({ erro: 'revisao.avaliacao_nao_encontrada', mensagem: 'A avaliação não existe mais.' })
    if (r.tipo === 'fora_da_amostra') {
      return reply.code(422).send({ erro: 'revisao.fora_da_amostra', mensagem: 'Esta avaliação não está na amostra da semana do número. Revise pela lista da amostra.' })
    }
    return reply.code(r.criada ? 201 : 200).send(r.revisao)
  })

  app.get<{ Querystring: { canalId?: string; semana?: string } }>(
    '/v1/agente/revisao/concordancia', { preHandler: GESTOR },
    async (req, reply) => {
      const { canalId, semana } = req.query
      if (canalId !== undefined && !UUID.test(canalId)) return reply.code(422).send({ erro: 'revisao.campo_invalido', campos: ['canalId'] })
      if (semana !== undefined && !SEMANA_RE.test(semana)) return semanaInvalida(reply)
      const r = await req.comTenant(async (tx) => {
        const s = await semanaDaLoja(tx, semana)
        if (!s) return null
        return { s, c: await concordancia(tx, { semanas: [s.semana], canalId }) }
      })
      if (!r) return semanaInvalida(reply)
      const corpo: ConcordanciaDto = {
        semana: r.s.semana, canalId: canalId ?? null, meta: META_CONCORDANCIA, minimoRevisadas: MIN_REVISADAS_CONCORDANCIA,
        ...r.c.total, porNumero: r.c.porNumero,
      }
      return reply.send(corpo)
    },
  )
}
