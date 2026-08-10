import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { exigirTenant } from '../../plugins/tenant.js'
import { garantirUsuarioId } from '../atendimento/rotas-fila.js'

/**
 * Metas de venda — alvo mensal (equipe ou por vendedor) com o REALIZADO derivado
 * das vendas do período. ⚠️ O realizado nunca é lido de um contador gravado: sai
 * de `venda` (excluindo canceladas), a mesma fonte de verdade do faturamento.
 *
 * Conjunto pequeno e limitado (uma meta por vendedor + a da equipe, por mês) —
 * não é grid de domínio, então a leitura por período não usa cursor.
 *
 * ⚠️ Só o tipo 'faturamento' tem realizado calculado hoje (é o dado que temos, em
 * centavos). Metas de outros tipos são aceitas, mas o realizado volta 0 até o
 * cálculo existir — sinalizado por `realizadoDisponivel`.
 */
export async function rotasMeta(app: FastifyInstance): Promise<void> {
  // Metas de um período (default: mês corrente), com realizado e progresso.
  app.get<{ Querystring: { ano?: string; mes?: string } }>(
    '/v1/metas', { preHandler: exigirTenant },
    async (req, reply) => {
      const agora = new Date()
      const ano = Number(req.query.ano) || agora.getUTCFullYear()
      const mes = Number(req.query.mes) || agora.getUTCMonth() + 1
      if (mes < 1 || mes > 12 || ano < 2000 || ano > 2100) {
        return reply.code(422).send({ erro: 'meta.periodo_invalido' })
      }
      const itens = await req.comTenant(async (tx) => {
        const metas = await tx<{
          id: string; usuario_id: string | null; usuario: string | null
          tipo: string; alvo: string
        }[]>`
          SELECT m.id, m.usuario_id, u.nome AS usuario, m.tipo, m.alvo::text AS alvo
            FROM meta m
            LEFT JOIN usuario u ON u.tenant_id = m.tenant_id AND u.id = m.usuario_id
           WHERE m.tenant_id = tenant_atual() AND m.ano = ${ano} AND m.mes = ${mes}
           ORDER BY (m.usuario_id IS NULL) DESC, u.nome ASC, m.tipo ASC`

        // Realizado de faturamento no mês: total por vendedor + total geral,
        // numa passada só (a partição da venda já limita o range).
        const inicio = `${ano}-${String(mes).padStart(2, '0')}-01`
        const realizado = await tx<{ usuario_id: string | null; total: string }[]>`
          SELECT usuario_id, sum(valor_centavos)::text AS total
            FROM venda
           WHERE tenant_id = tenant_atual()
             AND cancelada_em IS NULL
             AND ocorrida_em >= ${inicio}::date
             AND ocorrida_em <  (${inicio}::date + interval '1 month')
           GROUP BY usuario_id`
        const porVendedor = new Map<string, number>()
        let totalEquipe = 0
        for (const r of realizado) {
          const v = Number(r.total)
          totalEquipe += v
          if (r.usuario_id) porVendedor.set(r.usuario_id, v)
        }
        return metas.map((m) => {
          const alvo = Number(m.alvo)
          const disp = m.tipo === 'faturamento'
          const realizadoCentavos = !disp ? 0 : m.usuario_id === null ? totalEquipe : (porVendedor.get(m.usuario_id) ?? 0)
          return {
            id: m.id,
            usuarioId: m.usuario_id,
            usuario: m.usuario_id === null ? 'Equipe' : m.usuario,
            tipo: m.tipo,
            alvo,
            realizado: realizadoCentavos,
            realizadoDisponivel: disp,
            pct: disp && alvo > 0 ? Math.round((realizadoCentavos / alvo) * 100) : 0,
          }
        })
      })
      return reply.send({ ano, mes, itens })
    },
  )

  // Definir/atualizar uma meta. Upsert por (vendedor|equipe, período, tipo).
  app.post<{ Body: { usuarioId?: string | null; ano?: number; mes?: number; tipo?: string; alvoCentavos?: number } }>(
    '/v1/metas', { preHandler: exigirTenant },
    async (req, reply) => {
      const { ano, mes } = req.body ?? {}
      const usuarioId = req.body?.usuarioId ?? null
      const tipo = req.body?.tipo ?? 'faturamento'
      const alvo = req.body?.alvoCentavos
      if (!ano || !mes || mes < 1 || mes > 12) return reply.code(422).send({ erro: 'meta.periodo_invalido', mensagem: 'Informe ano e mês.' })
      if (!alvo || alvo <= 0) return reply.code(422).send({ erro: 'meta.alvo_invalido', mensagem: 'O alvo deve ser maior que zero.' })
      if (!['faturamento', 'pedidos', 'novos_clientes'].includes(tipo)) return reply.code(422).send({ erro: 'meta.tipo_invalido' })

      try {
        const id = await req.comTenant(async (tx) => {
          const eu = await garantirUsuarioId(tx, req)
          const novoId = randomUUID()
          // ⚠️ Dois índices parciais (equipe vs vendedor): o ON CONFLICT precisa
          // nomear a coluna-alvo certa, então trato os dois casos.
          const [r] = usuarioId === null
            ? await tx<{ id: string }[]>`
                INSERT INTO meta (tenant_id, id, usuario_id, ano, mes, tipo, alvo, criado_por)
                VALUES (tenant_atual(), ${novoId}, NULL, ${ano}, ${mes}, ${tipo}, ${alvo}, ${eu})
                ON CONFLICT (tenant_id, ano, mes, tipo) WHERE usuario_id IS NULL
                DO UPDATE SET alvo = EXCLUDED.alvo, atualizado_em = now()
                RETURNING id`
            : await tx<{ id: string }[]>`
                INSERT INTO meta (tenant_id, id, usuario_id, ano, mes, tipo, alvo, criado_por)
                VALUES (tenant_atual(), ${novoId}, ${usuarioId}, ${ano}, ${mes}, ${tipo}, ${alvo}, ${eu})
                ON CONFLICT (tenant_id, usuario_id, ano, mes, tipo) WHERE usuario_id IS NOT NULL
                DO UPDATE SET alvo = EXCLUDED.alvo, atualizado_em = now()
                RETURNING id`
          return r!.id
        })
        return reply.code(201).send({ id })
      } catch (e) {
        if (e instanceof Error && e.message.includes('meta_tenant_id_usuario_id_fkey')) {
          return reply.code(422).send({ erro: 'meta.usuario_invalido', mensagem: 'Vendedor não encontrado.' })
        }
        throw e
      }
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/v1/metas/:id', { preHandler: exigirTenant },
    async (req, reply) => {
      const [r] = await req.comTenant((tx) => tx`
        DELETE FROM meta WHERE tenant_id = tenant_atual() AND id = ${req.params.id} RETURNING id`)
      if (!r) return reply.code(404).send({ erro: 'meta.nao_encontrada' })
      return reply.send({ ok: true })
    },
  )
}
