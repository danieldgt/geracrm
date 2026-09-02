import type { FastifyInstance } from 'fastify'
import { exigirStaff, exigirTenant } from '../../plugins/tenant.js'
import { sql, comTenantServico } from '../../db/index.js'
import { auditar } from './auditoria.js'
import { abrirSessaoStaff, encerrarSessaoStaff, DURACAO_SESSAO_MIN } from './staff-sessao.js'

/**
 * Sessão de acesso do staff ao tenant de um cliente (PLT-05).
 *
 * ⚠️ Esta é a ÚNICA rota do produto que recebe um `tenantId`, e é assim por
 * desenho do contrato (§2.2): o staff não reusa as rotas do produto com
 * `?tenantId=` — ele troca de token. Depois da emissão, tudo volta ao normal:
 * o tenant vem do token, e o ADR-001 segue de pé. O que muda é quem emitiu.
 *
 * ⚠️ A sessão emitida NÃO carrega o grupo `staff`. Dentro do cliente o staff
 * opera como o cliente e não cadastra outras empresas — para isso, sai antes.
 */
export async function rotasStaff(app: FastifyInstance): Promise<void> {
  /**
   * Abre a sessão. O token volta em claro UMA vez.
   *
   * A trilha fica no tenant do CLIENTE — é ele quem precisa poder responder
   * "quem do drezz entrou aqui, quando e por quê". O índice parcial
   * `auditoria_staff` (migration 0004) existe exatamente para essa consulta.
   */
  app.post<{ Body: { tenantId?: string; motivo?: string } }>(
    '/v1/staff/acessos', { preHandler: [exigirTenant, exigirStaff] },
    async (req, reply) => {
      const alvo = req.body?.tenantId?.trim()
      const motivo = req.body?.motivo?.trim()
      if (!alvo) return reply.code(422).send({ erro: 'acesso.cliente_obrigatorio', mensagem: 'Escolha o cliente.' })
      if (!motivo) {
        // ⚠️ Motivo é obrigatório de propósito: acesso a dado de cliente sem
        //    justificativa registrada é o que uma auditoria externa cobra.
        return reply.code(422).send({ erro: 'acesso.motivo_obrigatorio', mensagem: 'Diga por que precisa entrar.' })
      }

      const [existe] = await sql<{ nome: string }[]>`
        SELECT nome FROM listar_tenants() WHERE id = ${alvo}`
      if (!existe) return reply.code(404).send({ erro: 'acesso.cliente_nao_encontrado' })

      const atorSub = req.usuarioSub ?? 'staff-sem-sub'
      const atorEmail = req.usuarioEmail ?? 'staff@drezz.com.br'

      const sessao = await comTenantServico(alvo, async (tx) => {
        const s = await abrirSessaoStaff(tx, { atorSub, atorEmail, motivo })
        // Mesmo commit do fato auditado (E7-01) — auditoria em try/catch à parte
        // é auditoria que falta justamente no incidente.
        await auditar(tx, {
          atorId: null, atorStaff: true,
          acao: 'staff.acesso_aberto', entidade: 'staff_sessao', entidadeId: s.id,
          dados: { staffEmail: atorEmail, motivo, expiraEm: s.expiraEm },
        })
        return s
      })

      return reply.code(201).send({
        token: sessao.token, expiraEm: sessao.expiraEm, duracaoMin: DURACAO_SESSAO_MIN,
        cliente: { id: alvo, nome: existe.nome },
      })
    },
  )

  /**
   * Encerra a sessão em uso. Chamada COM o token de acesso — o tenant já é o do
   * cliente, e `req.sessaoStaffId` diz qual sessão encerrar.
   */
  app.delete('/v1/staff/acessos/atual', { preHandler: exigirTenant }, async (req, reply) => {
    if (!req.sessaoStaffId) {
      return reply.code(422).send({ erro: 'acesso.sem_sessao', mensagem: 'Esta requisição não veio de uma sessão de acesso.' })
    }
    const ok = await req.comTenant(async (tx) => {
      const encerrada = await encerrarSessaoStaff(tx, req.sessaoStaffId!)
      if (encerrada) {
        await auditar(tx, {
          atorId: null, atorStaff: true,
          acao: 'staff.acesso_encerrado', entidade: 'staff_sessao', entidadeId: req.sessaoStaffId!,
          dados: { staffEmail: req.usuarioEmail ?? null },
        })
      }
      return encerrada
    })
    return reply.send({ ok })
  })

  /** As sessões abertas sobre este cliente — o "quem está aqui dentro agora". */
  app.get('/v1/staff/acessos', { preHandler: exigirTenant }, async (req, reply) => {
    const itens = await req.comTenant((tx) => tx<{
      id: string; ator_email: string; motivo: string; criada_em: Date; expira_em: Date
    }[]>`
      SELECT id, ator_email, motivo, criada_em, expira_em
        FROM staff_sessao
       WHERE tenant_id = tenant_atual() AND encerrada_em IS NULL AND expira_em > now()
       ORDER BY criada_em DESC`)
    return reply.send({
      itens: itens.map((s) => ({
        id: s.id, staffEmail: s.ator_email, motivo: s.motivo,
        criadaEm: s.criada_em, expiraEm: s.expira_em,
      })),
    })
  })
}
