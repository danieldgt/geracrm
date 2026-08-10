import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Sql } from '../../db/index.js'
import { exigirTenant } from '../../plugins/tenant.js'
import { auditar } from '../plataforma/auditoria.js'

/**
 * Fila e assunção (EP-06).
 *
 * ⚠️ "Assumir atendimento" é vencedor ATÔMICO por índice único (INV-51:
 * `atendimento_aberto_unico`), NUNCA `SELECT` antes de `INSERT`. Em 50 assunções
 * concorrentes da mesma conversa, exatamente 1 vence; as outras recebem erro
 * tipificado — e a tela já atualizou pelo tempo real.
 */

/** Garante o `usuario` do chamador (por cognito_sub) e devolve o id. */
export async function garantirUsuarioId(tx: Sql, req: FastifyRequest): Promise<string> {
  // Dev (header x-tenant-id, sem Cognito) usa um usuário sintético estável.
  const sub = req.usuarioSub ?? 'dev-header-sub'
  const email = req.usuarioEmail ?? 'dogfooding@geracrm.local'
  const nome = (email.split('@')[0] ?? 'Atendente') || 'Atendente'
  const [u] = await tx<{ id: string }[]>`
    INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email)
    VALUES (tenant_atual(), ${randomUUID()}, ${sub}, ${nome}, ${email})
    ON CONFLICT (cognito_sub) DO UPDATE SET email = EXCLUDED.email
    RETURNING id`
  return u!.id
}

async function emitirEvento(tx: Sql, conversaId: string): Promise<void> {
  const [conv] = await tx<{ versao: string }[]>`
    UPDATE conversa SET versao = versao + 1
     WHERE tenant_id = tenant_atual() AND id = ${conversaId} RETURNING versao`
  await tx`
    INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id, payload)
    VALUES (tenant_atual(), 'atendimento.mudou', 'conversa', ${conversaId},
            ${JSON.stringify({ conversaId, versao: Number(conv?.versao ?? 0) })}::text::jsonb)`
}

export async function rotasFila(app: FastifyInstance): Promise<void> {
  /** Busca de conversa por PROTOCOLO (E5-08). O número é a identidade. */
  app.get<{ Querystring: { p?: string } }>(
    '/v1/conversas/por-protocolo',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const p = Number(req.query.p)
      if (!Number.isSafeInteger(p) || p <= 0) return reply.code(422).send({ erro: 'protocolo.invalido' })
      const [row] = await req.comTenant((tx) => tx<{ conversa_id: string }[]>`
        SELECT conversa_id FROM atendimento
         WHERE tenant_id = tenant_atual() AND protocolo = ${p}
         ORDER BY criado_em DESC LIMIT 1`)
      if (!row) return reply.code(404).send({ erro: 'protocolo.nao_encontrado' })
      return reply.send({ conversaId: row.conversa_id })
    },
  )

  /** Contadores das abas (E6-02): fila (não assumidas) e meus (em atendimento). */
  app.get('/v1/fila/contadores', { preHandler: exigirTenant }, async (req, reply) => {
    const sub = req.usuarioSub ?? 'dev-header-sub'
    const r = await req.comTenant(async (tx) => {
      const [fila] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM conversa cv
         WHERE cv.tenant_id = tenant_atual() AND NOT cv.arquivada AND cv.ultima_direcao = 'entrante'
           AND NOT EXISTS (SELECT 1 FROM atendimento a
                            WHERE a.tenant_id = cv.tenant_id AND a.conversa_id = cv.id AND a.estado <> 'encerrado')`
      const [meus] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM atendimento a
         JOIN usuario u ON u.tenant_id = a.tenant_id AND u.id = a.atendente_id
         WHERE a.tenant_id = tenant_atual() AND a.estado <> 'encerrado' AND u.cognito_sub = ${sub}`
      return { fila: fila?.n ?? 0, meus: meus?.n ?? 0 }
    })
    return reply.send(r)
  })

  app.post<{ Params: { id: string } }>(
    '/v1/conversas/:id/assumir',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const conversaId = req.params.id
      const r = await req.comTenant(async (tx) => {
        const [conv] = await tx<{ canal_id: string }[]>`
          SELECT canal_id FROM conversa WHERE tenant_id = tenant_atual() AND id = ${conversaId}`
        if (!conv) return { tipo: 'nao_encontrada' as const }

        const usuarioId = await garantirUsuarioId(tx, req)

        // ⚠️ Vencedor atômico: o índice parcial único recusa um 2º aberto.
        const [criado] = await tx<{ protocolo: string }[]>`
          INSERT INTO atendimento
            (tenant_id, id, conversa_id, canal_id, protocolo, atendente_id, estado, assumido_em)
          SELECT tenant_atual(), ${randomUUID()}, ${conversaId}, ${conv.canal_id},
                 proximo_numero(tenant_atual(), 'protocolo'), ${usuarioId}, 'em_atendimento', now()
          ON CONFLICT (tenant_id, conversa_id) WHERE estado <> 'encerrado'
          DO NOTHING
          RETURNING protocolo`

        if (criado) {
          await emitirEvento(tx, conversaId)
          await auditar(tx, {
            atorId: usuarioId, acao: 'atendimento.assumido', entidade: 'conversa',
            entidadeId: conversaId, dados: { protocolo: Number(criado.protocolo) },
          })
          return { tipo: 'assumido' as const, protocolo: Number(criado.protocolo), meu: true }
        }

        // Já havia um atendimento aberto — quem tem?
        const [aberto] = await tx<{ atendente_id: string | null; nome: string | null; protocolo: string }[]>`
          SELECT a.atendente_id, u.nome, a.protocolo
            FROM atendimento a
            LEFT JOIN usuario u ON u.tenant_id = a.tenant_id AND u.id = a.atendente_id
           WHERE a.tenant_id = tenant_atual() AND a.conversa_id = ${conversaId} AND a.estado <> 'encerrado'`
        return {
          tipo: 'ja_aberto' as const,
          meu: aberto?.atendente_id === usuarioId,
          por: aberto?.nome ?? null,
          protocolo: Number(aberto?.protocolo ?? 0),
        }
      })

      if (r.tipo === 'nao_encontrada') return reply.code(404).send({ erro: 'conversa.nao_encontrada' })
      if (r.tipo === 'assumido') return reply.code(201).send({ ok: true, protocolo: r.protocolo, meu: true })
      // Já aberto: se é meu, 200 ok; se é de outro, 409 tipificado.
      if (r.meu) return reply.code(200).send({ ok: true, protocolo: r.protocolo, meu: true })
      return reply.code(409).send({ erro: 'atendimento.ja_assumido', mensagem: `Em atendimento por ${r.por ?? 'outro atendente'}.`, por: r.por })
    },
  )
}
