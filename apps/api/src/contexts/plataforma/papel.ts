import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Sql } from '../../db/index.js'
import { subDoUsuario } from '../../plugins/tenant.js'

/**
 * PAPEL DO USUÁRIO — quem pode CONFIGURAR (e não só usar) dentro de um tenant.
 *
 * De onde vem o papel, hoje (investigado na raia P0):
 *
 *   - `usuario_filial` (0005): papel POR FILIAL, `filial_id NULL` = todas.
 *     Valores: admin · gestor · supervisor · vendedor · atendente (CHECK).
 *     ⚠️ `usuario` NÃO tem coluna papel, de propósito (a mesma pessoa é gestora
 *     numa filial e atendente noutra).
 *   - Os grupos do Cognito (`req.usuarioGrupos`) só carregam `staff` — o que
 *     autoriza as rotas de PLATAFORMA (`exigirStaff`), nunca um papel dentro
 *     do cliente.
 *   - ⚠️ Nada no produto grava `usuario_filial` ainda: o usuário nasce em
 *     `garantirUsuarioId` (rotas-fila.ts) sem papel. Só a tela de equipe
 *     (`/v1/config/equipe`) LÊ os papéis.
 *
 * A REGRA (uma só, aqui — nunca replicada em rota ou tela):
 *
 *   1. Identidade = `usuario.cognito_sub` = `subDoUsuario(req)`, lida SOB RLS
 *      do tenant do token. Linha de outro tenant não existe para a consulta.
 *   2. Papéis do usuário = UNIÃO dos papéis em qualquer filial. As checagens
 *      que existem hoje (configurar o agente, privacidade, parear número) são
 *      de nível de TENANT; recorte por filial/número/carteira é outra pergunta
 *      (skill geracrm-identidade-acesso) e não mora aqui.
 *   3. Usuário inativo (`usuario.ativo = false`) não tem papel.
 *   4. ⚠️ MODO FUNDADOR: enquanto o tenant não tiver NENHUM ADMIN ATIVO em
 *      `usuario_filial`, todo usuário EXISTENTE e ATIVO do tenant vale `admin`.
 *      Exigir papel antes de existir quem o atribua trancaria todos os clientes
 *      fora da própria configuração (e mudaria o comportamento de hoje, em que
 *      todos configuram).
 *        - Só um ADMIN ativo encerra o modo fundador — não qualquer papel:
 *          atribuir "atendente" a alguém não pode deixar o tenant sem ninguém
 *          capaz de configurar (e de atribuir o próprio admin).
 *        - "Existente e ativo" = linha em `usuario` com o sub do token e
 *          `ativo`. A linha nasce em `garantirUsuarioId` (rotas-fila.ts), que o
 *          console chama no batimento de presença; token válido de alguém que
 *          o tenant desativou NÃO vira admin.
 *      Quando o primeiro admin ativo existe, a regra fica estrita para todos.
 *   5. Sessão de staff (PLT-05) age como `admin` do cliente: já é auditada e é
 *      o caminho de implantação.
 *   6. `admin` satisfaz qualquer exigência; os demais papéis valem só quando
 *      listados explicitamente em `exigirPapel(...)`.
 *
 * ⚠️ A decisão de acesso é revalidada a CADA requisição (sem cache): papel
 *    retirado deixa de valer na próxima chamada.
 */

export const PAPEIS = ['admin', 'gestor', 'supervisor', 'vendedor', 'atendente'] as const
export type Papel = (typeof PAPEIS)[number]

export interface AcessoDoUsuario {
  readonly papeis: readonly Papel[]
  /** Por que esses papéis: atribuídos, modo fundador, sessão de staff ou nenhum. */
  readonly origem: 'atribuido' | 'fundador' | 'staff' | 'nenhum'
}

/** Papéis de quem chama, no tenant da transação (`tenant_atual()`). */
export async function papeisDoUsuario(tx: Sql, quem: { sub: string; atorStaff?: boolean | undefined }): Promise<AcessoDoUsuario> {
  if (quem.atorStaff) return { papeis: ['admin'], origem: 'staff' }
  const [l] = await tx<{ papeis: string[] | null; usuario_ativo: boolean; tenant_tem_admin: boolean }[]>`
    SELECT (SELECT array_agg(DISTINCT uf.papel ORDER BY uf.papel)
              FROM usuario u
              JOIN usuario_filial uf ON uf.tenant_id = u.tenant_id AND uf.usuario_id = u.id
             WHERE u.tenant_id = tenant_atual() AND u.cognito_sub = ${quem.sub} AND u.ativo) AS papeis,
           EXISTS (SELECT 1 FROM usuario u
                    WHERE u.tenant_id = tenant_atual() AND u.cognito_sub = ${quem.sub} AND u.ativo) AS usuario_ativo,
           EXISTS (SELECT 1 FROM usuario_filial uf
                     JOIN usuario u ON u.tenant_id = uf.tenant_id AND u.id = uf.usuario_id
                    WHERE uf.tenant_id = tenant_atual() AND uf.papel = 'admin' AND u.ativo) AS tenant_tem_admin`
  if (!l?.usuario_ativo) return { papeis: [], origem: 'nenhum' }
  if (!l.tenant_tem_admin) return { papeis: ['admin'], origem: 'fundador' }
  const papeis = (l.papeis ?? []).filter((p): p is Papel => (PAPEIS as readonly string[]).includes(p))
  return { papeis, origem: papeis.length > 0 ? 'atribuido' : 'nenhum' }
}

/** O acesso satisfaz a exigência? `admin` satisfaz tudo. Puro. */
export function atendePapel(acesso: AcessoDoUsuario, aceitos: readonly Papel[]): boolean {
  return acesso.papeis.includes('admin') || acesso.papeis.some((p) => aceitos.includes(p))
}

/** Para usar DENTRO de um handler (ex.: `podeParear` na listagem de canais). */
export async function temPapel(req: FastifyRequest, ...aceitos: Papel[]): Promise<boolean> {
  if (!req.tenantId) return false
  const acesso = await req.comTenant((tx) => papeisDoUsuario(tx, { sub: subDoUsuario(req), atorStaff: req.atorStaff }))
  return atendePapel(acesso, aceitos)
}

/**
 * preHandler: exige um dos papéis (ou admin). Sem tenant → 401 como
 * `exigirTenant`; sem o papel → 403 `acesso.papel_insuficiente`, com os papéis
 * exigidos para a tela dizer a quem pedir.
 *
 *   app.put('/v1/...', { preHandler: [exigirTenant, exigirPapel('admin')] }, ...)
 */
export function exigirPapel(...aceitos: Papel[]) {
  return async function exigirPapelHandler(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
    if (!req.tenantId) {
      const erro = new Error('autenticacao.ausente') as Error & { statusCode?: number }
      erro.statusCode = 401
      throw erro
    }
    if (await temPapel(req, ...aceitos)) return undefined
    // ⚠️ `return reply`: em hook async, é o que diz ao Fastify que a resposta já saiu.
    return reply.code(403).send({
      erro: 'acesso.papel_insuficiente',
      mensagem: 'Seu papel não permite esta ação. Peça a um administrador.',
      exige: aceitos.length ? aceitos : ['admin'],
    })
  }
}
