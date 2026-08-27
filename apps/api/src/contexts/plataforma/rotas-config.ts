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
      ausente: boolean; visto_em: Date | null; canais: number
      papeis: { papel: string; filial: string }[]
    }[]>`
      SELECT u.id, u.nome, u.email, u.ativo, u.ausente, u.visto_em,
             -- ⚠️ tenant_atual(), e NÃO u.tenant_id: a coluna do outer query não
             --    está no GROUP BY e o Postgres recusa ("subquery uses ungrouped
             --    column"). O valor é o mesmo — a consulta já roda sob RLS do
             --    tenant do token (ADR-001).
             (SELECT count(*)::int FROM usuario_canal uc2
               WHERE uc2.tenant_id = tenant_atual() AND uc2.usuario_id = u.id) AS canais,
             COALESCE(
               json_agg(json_build_object('papel', uf.papel, 'filial', COALESCE(f.nome, 'Todas as filiais'))
                        ORDER BY uf.papel) FILTER (WHERE uf.papel IS NOT NULL),
               '[]'::json) AS papeis
        FROM usuario u
        LEFT JOIN usuario_filial uf ON uf.tenant_id = u.tenant_id AND uf.usuario_id = u.id
        LEFT JOIN filial f ON f.tenant_id = uf.tenant_id AND f.id = uf.filial_id
       WHERE u.tenant_id = tenant_atual()
       GROUP BY u.id, u.nome, u.email, u.ativo, u.ausente, u.visto_em
       ORDER BY u.ativo DESC, u.nome ASC
       LIMIT 200`)
    return reply.send({
      itens: linhas.map((l) => ({
        id: l.id, nome: l.nome, email: l.email, ativo: l.ativo, papeis: l.papeis,
        ausente: l.ausente,
        // ⚠️ Vai o CARIMBO, não um booleano "online": a tela mostra "visto há 3
        //    min" e quem lê decide. Booleano esconde o quanto a informação já
        //    envelheceu — o mesmo erro do estado de canal sem carimbo (0069).
        vistoEm: l.visto_em,
        canais: l.canais,
      })),
    })
  })

  /**
   * BATIMENTO — o console avisa que a pessoa está ali.
   *
   * ⚠️ É o que separa "ninguém logado" de "todo mundo logado": fechar o
   * navegador não avisa ninguém, então a AUSÊNCIA de sinal é o sinal. Sem isto,
   * o produto acharia que há gente na mesa a noite inteira e o agente nunca
   * assumiria (`disponibilidade.ts`).
   */
  app.post('/v1/config/presenca', { preHandler: exigirTenant }, async (req, reply) => {
    // ⚠️ Casa por `cognito_sub`: é quem o token identifica. Aceitar um id vindo
    //    do corpo deixaria um usuário marcar presença por outro.
    const sub = req.usuarioSub
    if (!sub) return reply.send({ ok: false, motivo: 'sem_usuario' })
    await req.comTenant((tx) => tx`
      UPDATE usuario SET visto_em = now()
       WHERE tenant_id = tenant_atual() AND cognito_sub = ${sub}`)
    return reply.send({ ok: true })
  })

  /**
   * O usuário se marca ausente (ou volta).
   *
   * ⚠️ Só sobre SI MESMO. Marcar outra pessoa como ausente seria decidir por ela
   * que o robô assume as conversas dela — e a pessoa descobriria pelo cliente.
   */
  app.patch<{ Body: { ausente?: boolean } }>(
    '/v1/config/ausencia', { preHandler: exigirTenant },
    async (req, reply) => {
      const ausente = req.body?.ausente === true
      const sub = req.usuarioSub
      if (!sub) return reply.code(422).send({ erro: 'sem_usuario', mensagem: 'Sessão sem usuário identificado.' })
      // ⚠️ Voltar de ausente também é sinal de vida: quem clicou está ali.
      await req.comTenant((tx) => tx`
        UPDATE usuario
           SET ausente = ${ausente},
               visto_em = CASE WHEN ${ausente} THEN visto_em ELSE now() END
         WHERE tenant_id = tenant_atual() AND cognito_sub = ${sub}`)
      return reply.send({ ok: true, ausente })
    },
  )
}
