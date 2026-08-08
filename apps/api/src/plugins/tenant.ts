import fp from 'fastify-plugin'
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { sql, type Sql } from '../db/index.js'

/**
 * Tenant plugin — the single place where "which company is this?" is decided.
 *
 * ADR-001: the tenant comes from the authenticated token, NEVER from a
 * parameter. There is no route that accepts `tenantId` in body, query or path;
 * such a route would be a bug even if it validated afterwards.
 *
 * ⚠️ The hard part is not reading the tenant — it is making sure it does not
 * survive the request. See `comTenant` below.
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** Tenant of the authenticated caller. Absent on public routes. */
    tenantId?: string
    /**
     * Runs a callback inside a transaction already scoped to this tenant.
     * Every domain query goes through here — RLS depends on it.
     */
    comTenant<T>(fn: (tx: Sql) => Promise<T>): Promise<T>
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Development-only escape hatch, guarded so it cannot reach production.
 *
 * ⚠️ Read at plugin registration, not at module import. Freezing config at
 * import time makes the module depend on load order — which is invisible in
 * production and breaks tests that set the environment in a `beforeAll`.
 */
function permiteHeaderDeTenant(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.DEV_TENANT_HEADER === 'on'
}

function lerTenant(req: FastifyRequest, permiteHeader: boolean): string | undefined {
  // TODO(E1-01): read `custom:tenant_id` from the verified Cognito JWT.
  // Until Cognito exists, development uses an explicit header — behind two
  // guards, because a header-based tenant in production is a total bypass.
  if (permiteHeader) {
    const bruto = req.headers['x-tenant-id']
    const valor = Array.isArray(bruto) ? bruto[0] : bruto
    if (valor && UUID.test(valor)) return valor
  }
  return undefined
}

export const pluginTenant: FastifyPluginAsync = fp(
  async (app) => {
    const permiteHeader = permiteHeaderDeTenant()

    if (permiteHeader) {
      app.log.warn(
        'DEV_TENANT_HEADER=on — o tenant vem do header X-Tenant-Id. ' +
          'Isto é um bypass total de autenticação e só existe fora de produção.',
      )
    }

    app.decorateRequest('tenantId', undefined)

    app.decorateRequest('comTenant', function (this: FastifyRequest, fn) {
      const tenantId = this.tenantId
      if (!tenantId) {
        // Failing loudly is deliberate: a query without tenant would run with
        // `tenant_atual()` NULL, and the policy would silently return nothing.
        // A confusing empty screen is worse to debug than a clear error.
        throw new Error('comTenant chamado sem tenant — rota autenticada?')
      }

      return sql.begin(async (tx) => {
        // ⚠️ SET LOCAL, not SET. LOCAL is scoped to the transaction, so the
        // value is gone when the connection returns to the pool. With plain
        // SET, the next request on that connection — possibly another
        // company's — would inherit this tenant.
        await tx`SELECT set_config('geracrm.tenant_id', ${tenantId}, true)`
        return fn(tx as unknown as Sql)
      }) as never
    })

    app.addHook('onRequest', async (req) => {
      req.tenantId = lerTenant(req, permiteHeader)
    })
  },
  { name: 'tenant' },
)

/** Guard for routes that require an authenticated tenant. */
export async function exigirTenant(req: FastifyRequest): Promise<void> {
  if (!req.tenantId) {
    const erro = new Error('autenticacao.ausente') as Error & { statusCode?: number }
    erro.statusCode = 401
    throw erro
  }
}
