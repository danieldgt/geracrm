import type { FastifyInstance } from 'fastify'
import { exigirTenant } from '../../plugins/tenant.js'

/**
 * Configurações Gerais — a empresa (nome, fuso, plano) e a equipe com os papéis.
 * ⚠️ Papel é POR FILIAL (usuario_filial), nunca global — a mesma pessoa pode ser
 * gestora numa filial e atendente em outra. A gestão de usuários/papéis (criar,
 * conceder) é de identidade/acesso e não entra aqui; esta tela MOSTRA e deixa
 * editar só os dados da própria empresa. Tenant sempre de tenant_atual() (ADR-001).
 */
export async function rotasConfig(app: FastifyInstance): Promise<void> {
  app.get('/v1/config/empresa', { preHandler: exigirTenant }, async (req, reply) => {
    const [e] = await req.comTenant((tx) => tx<{ nome: string; fuso: string; plano: string }[]>`
      SELECT t.nome, t.fuso, p.codigo AS plano
        FROM tenant t JOIN plano p ON p.id = t.plano_id
       WHERE t.id = tenant_atual()`)
    if (!e) return reply.code(404).send({ erro: 'empresa.nao_encontrada' })
    return reply.send({ nome: e.nome, fuso: e.fuso, plano: e.plano })
  })

  app.patch<{ Body: { nome?: string; fuso?: string } }>(
    '/v1/config/empresa', { preHandler: exigirTenant },
    async (req, reply) => {
      const nome = req.body?.nome?.trim()
      const fuso = req.body?.fuso?.trim()
      if (nome !== undefined && nome.length === 0) return reply.code(422).send({ erro: 'empresa.nome_obrigatorio', mensagem: 'O nome não pode ficar vazio.' })
      const [r] = await req.comTenant((tx) => tx`
        UPDATE tenant SET nome = COALESCE(${nome ?? null}, nome), fuso = COALESCE(${fuso || null}, fuso)
         WHERE id = tenant_atual() RETURNING id`)
      if (!r) return reply.code(404).send({ erro: 'empresa.nao_encontrada' })
      return reply.send({ ok: true })
    },
  )

  // Equipe: usuários com seus papéis por filial (leitura).
  app.get('/v1/config/equipe', { preHandler: exigirTenant }, async (req, reply) => {
    const linhas = await req.comTenant((tx) => tx<{
      id: string; nome: string; email: string | null; ativo: boolean
      papeis: { papel: string; filial: string }[]
    }[]>`
      SELECT u.id, u.nome, u.email, u.ativo,
             COALESCE(
               json_agg(json_build_object('papel', uf.papel, 'filial', COALESCE(f.nome, 'Todas as filiais'))
                        ORDER BY uf.papel) FILTER (WHERE uf.papel IS NOT NULL),
               '[]'::json) AS papeis
        FROM usuario u
        LEFT JOIN usuario_filial uf ON uf.tenant_id = u.tenant_id AND uf.usuario_id = u.id
        LEFT JOIN filial f ON f.tenant_id = uf.tenant_id AND f.id = uf.filial_id
       WHERE u.tenant_id = tenant_atual()
       GROUP BY u.id, u.nome, u.email, u.ativo
       ORDER BY u.ativo DESC, u.nome ASC
       LIMIT 200`)
    return reply.send({
      itens: linhas.map((l) => ({ id: l.id, nome: l.nome, email: l.email, ativo: l.ativo, papeis: l.papeis })),
    })
  })
}
