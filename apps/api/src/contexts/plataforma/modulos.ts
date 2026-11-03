import type { FastifyReply, FastifyRequest } from 'fastify'
import { MODULOS, type Modulo } from '@geracrm/shared'
import type { Sql } from '../../db/index.js'

/**
 * CHAVES DE MÓDULO por tenant (raia D5, 0116).
 *
 * ⚠️ Padrão DESLIGADO: sem linha em `tenant_modulo`, o módulo não existe para o
 *    tenant. Módulo opcional que nasce ligado vira obrigação silenciosa.
 * ⚠️ Lido sempre SOB RLS (`tenant_atual()`), nunca por parâmetro de tenant.
 */

/** O módulo está ligado para o tenant da transação? */
export async function moduloAtivo(tx: Sql, modulo: Modulo): Promise<boolean> {
  const [l] = await tx<{ ativo: boolean }[]>`
    SELECT ativo FROM tenant_modulo WHERE tenant_id = tenant_atual() AND modulo = ${modulo}`
  return l?.ativo === true
}

/** Estado de todos os módulos conhecidos (os sem linha vêm desligados). */
export async function listarModulos(tx: Sql): Promise<Record<Modulo, boolean>> {
  const linhas = await tx<{ modulo: string; ativo: boolean }[]>`
    SELECT modulo, ativo FROM tenant_modulo WHERE tenant_id = tenant_atual()`
  const estado = Object.fromEntries(MODULOS.map((m) => [m, false])) as Record<Modulo, boolean>
  for (const l of linhas) if ((MODULOS as readonly string[]).includes(l.modulo)) estado[l.modulo as Modulo] = l.ativo
  return estado
}

/**
 * preHandler: 404 quando o módulo está desligado (a rota "não existe" para o
 * tenant — não é 403, que sugeriria permissão). Usar DEPOIS de `exigirTenant`.
 *
 *   app.get('/v1/agenda', { preHandler: [exigirTenant, exigirModulo('agenda')] }, ...)
 */
export function exigirModulo(modulo: Modulo) {
  return async function exigirModuloHandler(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
    if (!req.tenantId) {
      const erro = new Error('autenticacao.ausente') as Error & { statusCode?: number }
      erro.statusCode = 401
      throw erro
    }
    if (await req.comTenant((tx) => moduloAtivo(tx, modulo))) return undefined
    return reply.code(404).send({ erro: 'modulo.desligado', mensagem: 'Este módulo não está ligado para a sua empresa.' })
  }
}
