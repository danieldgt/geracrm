import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { exigirTenant } from '../../plugins/tenant.js'
import { garantirUsuarioId } from '../atendimento/rotas-fila.js'

const PAGINA = 20
const DIAS_VALIDOS = new Set([30, 90, 180, 365])

/**
 * NPS — satisfação. ⚠️ O score é DERIVADO na leitura (padrão NPS):
 *   promotor 9–10, neutro 7–8, detrator 0–6; NPS = %promotores − %detratores.
 * Nada de faixa gravada. Comentários recentes vêm paginados por cursor.
 *
 * A coleta automática (perguntar na conversa) é outra história; aqui registra e
 * apura o que já foi respondido — inclusive lançamento à mão (origem='manual').
 */
export async function rotasNps(app: FastifyInstance): Promise<void> {
  // Painel: score + distribuição + comentários recentes de um período.
  app.get<{ Querystring: { dias?: string; cursor?: string } }>(
    '/v1/nps', { preHandler: exigirTenant },
    async (req, reply) => {
      const dias = DIAS_VALIDOS.has(Number(req.query.dias)) ? Number(req.query.dias) : 90
      let curEm: string | null = null, curId: string | null = null
      if (req.query.cursor) {
        const [em, id] = Buffer.from(req.query.cursor, 'base64url').toString('utf8').split('§')
        if (!em || !id) return reply.code(422).send({ erro: 'cursor.invalido' })
        curEm = em; curId = id
      }
      const dados = await req.comTenant(async (tx) => {
        const desde = tx`now() - (${dias} || ' days')::interval`
        const [resumo] = await tx<{
          total: number; promotores: number; neutros: number; detratores: number
        }[]>`
          SELECT count(*)::int AS total,
                 count(*) FILTER (WHERE nota >= 9)::int AS promotores,
                 count(*) FILTER (WHERE nota BETWEEN 7 AND 8)::int AS neutros,
                 count(*) FILTER (WHERE nota <= 6)::int AS detratores
            FROM nps_resposta
           WHERE tenant_id = tenant_atual() AND respondido_em >= ${desde}`

        const comentarios = await tx<{
          id: string; nota: number; comentario: string | null; respondido_em: Date
          contato_id: string | null; contato: string | null
        }[]>`
          SELECT n.id, n.nota, n.comentario, n.respondido_em, n.contato_id, c.nome AS contato
            FROM nps_resposta n
            LEFT JOIN contato c ON c.tenant_id = n.tenant_id AND c.id = n.contato_id
           WHERE n.tenant_id = tenant_atual() AND n.respondido_em >= ${desde}
             AND n.comentario IS NOT NULL AND n.comentario <> ''
             AND ${curEm === null ? tx`true` : tx`(n.respondido_em, n.id) < (${curEm}::timestamptz, ${curId}::uuid)`}
           ORDER BY n.respondido_em DESC, n.id DESC LIMIT ${PAGINA + 1}`
        return { resumo, comentarios }
      })

      const r = dados.resumo
      const total = r?.total ?? 0
      const promotores = r?.promotores ?? 0
      const detratores = r?.detratores ?? 0
      const score = total > 0 ? Math.round(((promotores - detratores) / total) * 100) : null

      const temMais = dados.comentarios.length > PAGINA
      const pagina = temMais ? dados.comentarios.slice(0, PAGINA) : dados.comentarios
      const ultimo = pagina[pagina.length - 1]
      return reply.send({
        dias,
        total,
        score,
        distribuicao: { promotores, neutros: r?.neutros ?? 0, detratores },
        comentarios: pagina.map((c) => ({
          id: c.id, nota: c.nota, comentario: c.comentario, respondidoEm: c.respondido_em,
          contatoId: c.contato_id, contato: c.contato,
          faixa: c.nota >= 9 ? 'promotor' : c.nota >= 7 ? 'neutro' : 'detrator',
        })),
        proximoCursor: temMais && ultimo
          ? Buffer.from(`${ultimo.respondido_em.toISOString()}§${ultimo.id}`).toString('base64url') : null,
      })
    },
  )

  // Registrar uma resposta (à mão, ou de outra origem).
  app.post<{ Body: { contatoId?: string | null; nota?: number; comentario?: string; origem?: string } }>(
    '/v1/nps', { preHandler: exigirTenant },
    async (req, reply) => {
      const nota = req.body?.nota
      if (!Number.isInteger(nota) || nota! < 0 || nota! > 10) {
        return reply.code(422).send({ erro: 'nps.nota_invalida', mensagem: 'A nota vai de 0 a 10.' })
      }
      const origem = req.body?.origem ?? 'manual'
      if (!['manual', 'campanha', 'conversa', 'importacao'].includes(origem)) {
        return reply.code(422).send({ erro: 'nps.origem_invalida' })
      }
      const id = randomUUID()
      try {
        await req.comTenant(async (tx) => {
          const eu = await garantirUsuarioId(tx, req)
          await tx`INSERT INTO nps_resposta (tenant_id, id, contato_id, nota, comentario, origem, criado_por)
                   VALUES (tenant_atual(), ${id}, ${req.body?.contatoId ?? null}, ${nota!},
                           ${req.body?.comentario?.trim() || null}, ${origem}, ${eu})`
        })
        return reply.code(201).send({ id })
      } catch (e) {
        if (e instanceof Error && e.message.includes('nps_resposta_tenant_id_contato_id_fkey')) {
          return reply.code(422).send({ erro: 'nps.contato_invalido', mensagem: 'Contato não encontrado.' })
        }
        throw e
      }
    },
  )
}
