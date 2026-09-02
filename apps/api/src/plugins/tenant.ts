import fp from 'fastify-plugin'
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { sql, type Sql } from '../db/index.js'
import {
  criarVerificadorCognito, exigirCognitoEmProducao, type VerificadorCognito,
} from './cognito.js'
import {
  PREFIXO_SESSAO_STAFF, resolverSessaoStaff,
} from '../contexts/plataforma/staff-sessao.js'

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
    /** Grupos do Cognito (`cognito:groups`). Autoriza as rotas de plataforma. */
    usuarioGrupos?: readonly string[] | undefined
    /**
     * A requisição chegou por uma sessão de acesso do staff (PLT-05): quem age é
     * alguém do drezz, dentro do tenant de um cliente. Vale para a trilha
     * (`auditoria.ator_staff`) e para o log — nunca para autorizar.
     */
    atorStaff?: boolean | undefined
    /** Id da sessão de acesso em uso, para encerrá-la. */
    sessaoStaffId?: string | undefined
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
 * ⚠️ Ordem: sessão de staff PRIMEIRO (reconhecida pelo prefixo, sem custo),
 * depois Cognito. O `custom:tenant_id` do JWT assinado continua sendo a fonte
 * real (ADR-001); a sessão de acesso é a exceção que o contrato desenhou —
 * muda **quem emitiu** o token, não o fato de o tenant vir de um token.
 *
 * ⚠️ O header `x-tenant-id` é o bypass de dogfooding e só entra quando NÃO há
 * token e o modo dev está ligado — nunca por cima de um token.
 *
 * ⚠️ A sessão de staff é verificada mesmo quando o Cognito não está configurado
 * (dev): o teste local do PLT-05 depende disso. O antigo `if (verificador &&
 * token)` pulava o ramo inteiro sem Cognito.
 */
async function lerTenant(
  req: FastifyRequest,
  verificador: VerificadorCognito | null,
  permiteHeader: boolean,
): Promise<{
  tenantId?: string; sub?: string; email?: string | undefined
  grupos?: readonly string[]; atorStaff?: boolean; sessaoStaffId?: string
}> {
  const token = extrairToken(req)

  if (token?.startsWith(PREFIXO_SESSAO_STAFF)) {
    const sessao = await resolverSessaoStaff(token)
    if (sessao) {
      // ⚠️ Sem `grupos`: dentro do cliente o staff opera como o cliente e NÃO
      //    cadastra outras empresas. Para isso, sai da sessão primeiro.
      return {
        tenantId: sessao.tenant_id, sub: sessao.ator_sub, email: sessao.ator_email,
        grupos: [], atorStaff: true, sessaoStaffId: sessao.sessao_id,
      }
    }
    // Expirada, encerrada ou inexistente: fica sem tenant → 401. NÃO cai no
    // Cognito nem no header de dev.
    req.log.debug('sessao de staff nao resolve (expirada, encerrada ou inexistente)')
    return {}
  }

  if (verificador && token) {
    try {
      const id = await verificador.verificar(token)
      return { tenantId: id.tenantId, sub: id.sub, email: id.email, grupos: id.grupos }
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
      const id = await lerTenant(req, verificador, permiteHeader)
      req.tenantId = id.tenantId
      req.usuarioSub = id.sub
      req.usuarioEmail = id.email
      req.usuarioGrupos = id.grupos ?? []
      req.atorStaff = id.atorStaff ?? false
      req.sessaoStaffId = id.sessaoStaffId
      // ⚠️ Toda ação do staff dentro de um cliente fica no log, não só na
      //    trilha: é a pergunta "o que a Gera3 andou vendo?" respondida sem
      //    depender de a rota ter lembrado de auditar.
      if (id.atorStaff) {
        req.log.info({ tenant: id.tenantId, staff: id.email }, 'requisicao por sessao de staff')
      }
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

/** Grupo do Cognito que autoriza as rotas de plataforma. */
export const GRUPO_STAFF = 'staff'

/**
 * Guard das rotas de PLATAFORMA (cadastro de cliente) — as únicas que operam
 * fora do escopo de um tenant.
 *
 * ⚠️ É o único lugar que autoriza `criar_tenant()`/`listar_tenants()`: as
 * funções SECURITY DEFINER da migration 0080 não checam chamador (não têm como
 * — a identidade está no JWT, não no banco). Tirar este guard de uma rota de
 * plataforma expõe a base inteira de clientes.
 *
 * ⚠️ Em dev, o header `x-tenant-id` não carrega grupo nenhum; para exercitar
 * estas rotas fora de produção existe `DEV_STAFF=on`, que vale pelas MESMAS
 * duas travas do header de dev (nunca em produção).
 */
export async function exigirStaff(req: FastifyRequest): Promise<void> {
  const ehStaff = (req.usuarioGrupos ?? []).includes(GRUPO_STAFF)
  const bypassDev = process.env.NODE_ENV !== 'production' && process.env.DEV_STAFF === 'on'
  if (ehStaff || bypassDev) return

  const erro = new Error('autorizacao.sem_permissao') as Error & { statusCode?: number }
  erro.statusCode = req.tenantId ? 403 : 401
  throw erro
}
