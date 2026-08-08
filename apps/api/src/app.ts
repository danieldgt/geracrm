import Fastify, { type FastifyInstance } from 'fastify'
import { sql } from './db/index.js'
import { pluginTenant, exigirTenant } from './plugins/tenant.js'

/**
 * Builds the app without listening — so tests can use `app.inject()`
 * without opening a port.
 */
export async function criarApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      process.env.NODE_ENV === 'test'
        ? false
        : {
            level: process.env.LOG_LEVEL ?? 'info',
            // ⚠️ Conversation content must never reach the logs
            // (geracrm-observabilidade). Redact at the source, not later.
            redact: ['req.headers.authorization', 'req.headers["x-tenant-id"]'],
          },
  })

  await app.register(pluginTenant)

  /** Liveness — no database. Answers even with the bank down, on purpose. */
  app.get('/saude', async () => ({ ok: true, versao: process.env.npm_package_version ?? '0.0.0' }))

  /** Readiness — with database. This is the one the deploy should look at. */
  app.get('/pronto', async (_req, reply) => {
    try {
      await sql`SELECT 1`
      return { ok: true, banco: 'ok' }
    } catch {
      // Degrades in a localised way and names the failing subsystem, instead of
      // a generic 500 that says nothing to whoever is on call.
      return reply.code(503).send({ ok: false, banco: 'indisponivel' })
    }
  })

  /**
   * First domain route. Exists to prove the plugin end to end: the tenant comes
   * from the caller's identity, and RLS — not the query — decides what is
   * visible. Note there is no `WHERE tenant_id = ...` anywhere.
   */
  app.get('/v1/eu', { preHandler: exigirTenant }, async (req) => {
    return req.comTenant(async (tx) => {
      const [tenant] = await tx`
        SELECT t.id, t.nome, t.fuso, p.codigo AS plano, p.modulos
          FROM tenant t
          JOIN plano  p ON p.id = t.plano_id
      `
      return { tenant: tenant ?? null }
    })
  })

  app.setErrorHandler((erro, req, reply) => {
    const status = (erro as { statusCode?: number }).statusCode ?? 500
    if (status >= 500) req.log.error({ erro }, 'falha nao tratada')
    // Typed error, never the raw message — the screen needs a code it can branch on.
    return reply.code(status).send({
      erro: status === 401 ? 'autenticacao.ausente' : 'erro.interno',
      mensagem: status === 401 ? 'Autenticação ausente ou inválida.' : 'Erro interno.',
    })
  })

  return app
}
