import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { exigirTenant } from '../../plugins/tenant.js'
import { garantirUsuarioId } from '../atendimento/rotas-fila.js'

const DIAS_VALIDOS = new Set([30, 90, 180, 365])

/**
 * NPS — satisfação PÓS-ATENDIMENTO. A nota (0–10) avalia a conversa com um
 * vendedor, então o painel mostra o NPS POR ATENDENTE. ⚠️ Score DERIVADO na
 * leitura (padrão): promotor 9–10, neutro 7–8, detrator 0–6;
 * NPS = %promotores − %detratores. Nada de faixa/score gravado.
 */
function apurar(total: number, promotores: number, detratores: number): number | null {
  return total > 0 ? Math.round(((promotores - detratores) / total) * 100) : null
}

export async function rotasNps(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { dias?: string } }>(
    '/v1/nps', { preHandler: exigirTenant },
    async (req, reply) => {
      const dias = DIAS_VALIDOS.has(Number(req.query.dias)) ? Number(req.query.dias) : 90
      const dados = await req.comTenant(async (tx) => {
        const desde = tx`now() - (${dias} || ' days')::interval`
        const [geral] = await tx<{ total: number; promotores: number; detratores: number; atribuidas: number }[]>`
          SELECT count(*)::int AS total,
                 count(*) FILTER (WHERE nota >= 9)::int AS promotores,
                 count(*) FILTER (WHERE nota <= 6)::int AS detratores,
                 count(*) FILTER (WHERE atendente_id IS NOT NULL)::int AS atribuidas
            FROM nps_resposta
           WHERE tenant_id = tenant_atual() AND respondido_em >= ${desde}`

        const porAtendente = await tx<{
          atendente_id: string; nome: string | null
          total: number; promotores: number; neutros: number; detratores: number
        }[]>`
          SELECT n.atendente_id, u.nome,
                 count(*)::int AS total,
                 count(*) FILTER (WHERE n.nota >= 9)::int AS promotores,
                 count(*) FILTER (WHERE n.nota BETWEEN 7 AND 8)::int AS neutros,
                 count(*) FILTER (WHERE n.nota <= 6)::int AS detratores
            FROM nps_resposta n
            LEFT JOIN usuario u ON u.tenant_id = n.tenant_id AND u.id = n.atendente_id
           WHERE n.tenant_id = tenant_atual() AND n.respondido_em >= ${desde}
             AND n.atendente_id IS NOT NULL
           GROUP BY n.atendente_id, u.nome`
        return { geral, porAtendente }
      })

      const g = dados.geral
      const atendentes = dados.porAtendente
        .map((a) => ({
          usuarioId: a.atendente_id,
          nome: a.nome ?? 'Desconhecido',
          total: a.total,
          promotores: a.promotores,
          neutros: a.neutros,
          detratores: a.detratores,
          score: apurar(a.total, a.promotores, a.detratores),
        }))
        // Mais respostas primeiro; score desempata (quem tem base maior é mais confiável).
        .sort((x, y) => y.total - x.total || (y.score ?? -999) - (x.score ?? -999))

      return reply.send({
        dias,
        geral: {
          total: g?.total ?? 0,
          score: apurar(g?.total ?? 0, g?.promotores ?? 0, g?.detratores ?? 0),
          semAtendente: (g?.total ?? 0) - (g?.atribuidas ?? 0),
        },
        porAtendente: atendentes,
      })
    },
  )

  // Registrar uma resposta pós-atendimento (à mão, ou de outra origem).
  app.post<{ Body: { contatoId?: string | null; atendenteId?: string | null; nota?: number; comentario?: string; origem?: string } }>(
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
          await tx`INSERT INTO nps_resposta (tenant_id, id, contato_id, atendente_id, nota, comentario, origem, criado_por)
                   VALUES (tenant_atual(), ${id}, ${req.body?.contatoId ?? null}, ${req.body?.atendenteId ?? null},
                           ${nota!}, ${req.body?.comentario?.trim() || null}, ${origem}, ${eu})`
        })
        return reply.code(201).send({ id })
      } catch (e) {
        if (e instanceof Error && e.message.includes('nps_resposta_tenant_id_contato_id_fkey')) {
          return reply.code(422).send({ erro: 'nps.contato_invalido', mensagem: 'Contato não encontrado.' })
        }
        if (e instanceof Error && e.message.includes('nps_resposta_atendente_fk')) {
          return reply.code(422).send({ erro: 'nps.atendente_invalido', mensagem: 'Atendente não encontrado.' })
        }
        throw e
      }
    },
  )
}
