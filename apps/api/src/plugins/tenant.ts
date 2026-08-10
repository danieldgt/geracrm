import fp from 'fastify-plugin'
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { sql, type Sql } from '../db/index.js'
import {
  criarVerificadorCognito, exigirCognitoEmProducao, type VerificadorCognito,
} from './cognito.js'

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
    // ⚠️ `| undefined` explícito, não só `?`. Com exactOptionalPropertyTypes,
    // `?: string` significa "ausente OU string" — e nunca "presente valendo
    // undefined", que é exatamente o que o hook atribui quando não há tenant.
    tenantId?: string | undefined
    /** `sub` do usuário Cognito autenticado. Para auditoria e log — nunca
     *  para decidir o tenant (isso é `tenantId`). Ausente no header de dev. */
    usuarioSub?: string | undefined
    /** E-mail do usuário Cognito — para provisionar `usuario` (nome/email). */
    usuarioEmail?: string | undefined
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

/** Lê o Bearer do header Authorization, se houver. */
function extrairToken(req: FastifyRequest): string | undefined {
  const auth = req.headers['authorization']
  const valor = Array.isArray(auth) ? auth[0] : auth
  if (valor?.startsWith('Bearer ')) return valor.slice(7)
  return undefined
}

/**
 * Descobre de qual empresa é o chamador.
 *
 * ⚠️ Ordem: Cognito PRIMEIRO. O `custom:tenant_id` do JWT assinado é a fonte
 * real (ADR-001). O header `x-tenant-id` é o bypass de dogfooding e só entra
 * quando NÃO há token e o modo dev está ligado — nunca por cima de um token.
 */
async function lerTenant(
  req: FastifyRequest,
  verificador: VerificadorCognito | null,
  permiteHeader: boolean,
): Promise<{ tenantId?: string; sub?: string; email?: string | undefined }> {
  const token = extrairToken(req)
  if (verificador && token) {
    try {
      const id = await verificador.verificar(token)
      return { tenantId: id.tenantId, sub: id.sub, email: id.email }
    } catch (erro) {
      // ⚠️ Token inválido/expirado NÃO cai no header de dev: seria um caminho
      //    para escalar de "token ruim" para "escolho meu tenant". Fica sem
      //    tenant, e `exigirTenant` devolve 401.
      req.log.debug({ erro: erro instanceof Error ? erro.message : String(erro) }, 'jwt cognito rejeitado')
      return {}
    }
  }

  // Sem token: só o header de dev, atrás de dois guardas.
  if (permiteHeader) {
    const bruto = req.headers['x-tenant-id']
    const valor = Array.isArray(bruto) ? bruto[0] : bruto
    if (valor && UUID.test(valor)) return { tenantId: valor }
  }
  return {}
}

export const pluginTenant: FastifyPluginAsync = fp(
  async (app) => {
    const permiteHeader = permiteHeaderDeTenant()
    // ⚠️ O verificador é criado UMA vez (cacheia o JWKS). Criar por request
    //    faria cada chamada rebaixar o JWKS da AWS.
    const verificador = criarVerificadorCognito()
    // ⚠️ Em produção sem Cognito o processo NÃO sobe — ver a trava.
    exigirCognitoEmProducao(verificador)

    if (verificador) {
      app.log.info('Cognito ativo — o tenant vem de custom:tenant_id do JWT.')
    }
    if (permiteHeader) {
      app.log.warn(
        'DEV_TENANT_HEADER=on — o tenant pode vir do header X-Tenant-Id quando não há token. ' +
          'Isto é um bypass e só existe fora de produção.',
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
      const { tenantId, sub, email } = await lerTenant(req, verificador, permiteHeader)
      req.tenantId = tenantId
      req.usuarioSub = sub
      req.usuarioEmail = email
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
