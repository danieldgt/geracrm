import type { FastifyInstance } from 'fastify'
import { exigirTenant } from '../../plugins/tenant.js'
import { garantirUsuarioId } from './rotas-fila.js'

/**
 * Presença na conversa (INB-18) — "Eduarda está nesta conversa".
 *
 * ⚠️ SEM conexão viva e SEM polling de fundo: o heartbeat é um POST que a tela
 * faz SÓ enquanto a conversa está aberta, e a MESMA resposta já devolve quem
 * mais está ali. Um round-trip cobre escrever a própria presença e ler a dos
 * outros — dentro do intervalo de heartbeat, todos veem todos.
 *
 * O TTL é lógico: a leitura só conta quem bateu dentro da janela; quem fecha a
 * aba simplesmente para de bater e some. A limpeza física é oportunista.
 */
const TTL_SEGUNDOS = 40

export async function rotasPresenca(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string } }>(
    '/v1/conversas/:id/presenca',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const conversaId = req.params.id
      const r = await req.comTenant(async (tx) => {
        const [c] = await tx`SELECT 1 FROM conversa WHERE tenant_id = tenant_atual() AND id = ${conversaId}`
        if (!c) return null

        const usuarioId = await garantirUsuarioId(tx, req)
        // Bate o próprio coração (upsert).
        await tx`
          INSERT INTO presenca_conversa (tenant_id, conversa_id, usuario_id, visto_em)
          VALUES (tenant_atual(), ${conversaId}, ${usuarioId}, now())
          ON CONFLICT (tenant_id, conversa_id, usuario_id) DO UPDATE SET visto_em = now()`

        // Limpeza oportunista: tira os expirados desta conversa (tabela minúscula).
        await tx`
          DELETE FROM presenca_conversa
           WHERE tenant_id = tenant_atual() AND conversa_id = ${conversaId}
             AND visto_em < now() - make_interval(secs => ${TTL_SEGUNDOS})`

        // Quem MAIS está aqui, dentro do TTL (nunca eu mesmo).
        const outros = await tx<{ usuarioId: string; nome: string }[]>`
          SELECT p.usuario_id AS "usuarioId", u.nome
            FROM presenca_conversa p
            JOIN usuario u ON u.tenant_id = p.tenant_id AND u.id = p.usuario_id
           WHERE p.tenant_id = tenant_atual() AND p.conversa_id = ${conversaId}
             AND p.usuario_id <> ${usuarioId}
             AND p.visto_em > now() - make_interval(secs => ${TTL_SEGUNDOS})
           ORDER BY u.nome`
        return { outros }
      })
      if (!r) return reply.code(404).send({ erro: 'conversa.nao_encontrada' })
      return reply.send(r)
    },
  )

  /** Saída explícita — ao fechar a conversa, some na hora (sem esperar o TTL). */
  app.delete<{ Params: { id: string } }>(
    '/v1/conversas/:id/presenca',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const conversaId = req.params.id
      await req.comTenant(async (tx) => {
        const usuarioId = await garantirUsuarioId(tx, req)
        await tx`
          DELETE FROM presenca_conversa
           WHERE tenant_id = tenant_atual() AND conversa_id = ${conversaId} AND usuario_id = ${usuarioId}`
      })
      return reply.send({ ok: true })
    },
  )
}
