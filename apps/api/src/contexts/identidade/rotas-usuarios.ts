import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Sql } from '../../db/index.js'
import { exigirTenant } from '../../plugins/tenant.js'
import { atorDaRequisicao, garantirUsuarioId } from '../atendimento/rotas-fila.js'
import { auditar } from '../plataforma/auditoria.js'
import { exigirAdminAtribuido, PAPEIS, type Papel } from '../plataforma/papel.js'
import type { AlvoIdentidade, ProvedorIdentidade, ResultadoOperacao } from './provedor-identidade.js'
import { naoEhLinhaDeStaff } from './linha-staff.js'

/**
 * CADASTRO DE USUÁRIOS (raia D3, #97/#103) — só ADMIN ATRIBUÍDO ou sessão de
 * staff (`exigirAdminAtribuido`): o modo fundador NÃO vale aqui.
 *
 * ⚠️ STAFF FORA DO CADASTRO (revisão de segurança D3): linhas legadas que a
 *    sessão de staff gravou no cliente (`naoEhLinhaDeStaff`) não aparecem na
 *    lista e respondem 404 em toda ação; o provedor só opera sobre o login pelo
 *    `sub` da linha, do MESMO tenant e fora do grupo `staff` (`recusado` → 403).
 *    E-mail que já tem login no provedor (outro tenant, staff) → 409 genérico.
 *
 * ⚠️ Gestão de usuários SEMPRE pela aplicação (skill geracrm-identidade-acesso):
 *    o login nasce no provedor de identidade atrás da porta `ProvedorIdentidade`
 *    (Cognito em produção, falso nos testes) e o vínculo com o tenant nasce aqui,
 *    na MESMA operação — `usuario` + `usuario_filial`.
 *
 * ⚠️ O papel é POR FILIAL (`usuario_filial`, 0005): `papeis` é a lista inteira
 *    de vínculos `{ papel, filialId }` (`filialId: null` = todas as filiais) e
 *    o PATCH a SUBSTITUI. Uma pessoa pode ser gestora numa filial e vendedora
 *    noutra.
 *
 * ⚠️ O ÚLTIMO ADMIN ATIVO não se rebaixa nem se desativa (422
 *    `usuario.ultimo_admin`): ninguém mais conseguiria configurar o tenant — e
 *    o modo fundador não volta sozinho para quem já o encerrou.
 *    As mudanças de vínculo/ativo correm sob uma trava por tenant: dois admins
 *    rebaixando um ao outro ao mesmo tempo não zeram o tenant.
 *
 * ⚠️ Tenant SEMPRE de `tenant_atual()` (ADR-001). Toda mudança é auditada
 *    ("alteração de permissão" é evento obrigatório de auditoria).
 */

const PAGINA = 30
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const SENHA_MINIMA = 8

interface Vinculo { readonly papel: Papel; readonly filialId: string | null }

/** Erro de validação tipificado, para a tela apontar o campo. */
interface Recusa { readonly status: number; readonly erro: string; readonly mensagem: string }

const recusa = (status: number, erro: string, mensagem: string): Recusa => ({ status, erro, mensagem })

/** Valida a lista de vínculos (formato). Existência das filiais é no banco. */
function lerVinculos(bruto: unknown): Vinculo[] | Recusa {
  if (!Array.isArray(bruto)) return recusa(422, 'usuario.papeis_invalidos', 'Informe os papéis como lista de { papel, filialId }.')
  const vistos = new Set<string>()
  const out: Vinculo[] = []
  for (const v of bruto as unknown[]) {
    const papel = (v as { papel?: unknown })?.papel
    const filialId = (v as { filialId?: unknown })?.filialId ?? null
    if (typeof papel !== 'string' || !(PAPEIS as readonly string[]).includes(papel)) {
      return recusa(422, 'usuario.papel_invalido', `Papel inválido. Use: ${PAPEIS.join(', ')}.`)
    }
    if (filialId !== null && (typeof filialId !== 'string' || !UUID.test(filialId))) {
      return recusa(422, 'usuario.filial_invalida', 'Filial inválida.')
    }
    // ⚠️ Um papel por (usuário, filial) — é o índice único da 0005.
    const chave = filialId ?? '*'
    if (vistos.has(chave)) return recusa(422, 'usuario.papeis_duplicados', 'Só um papel por filial.')
    vistos.add(chave)
    out.push({ papel: papel as Papel, filialId: filialId as string | null })
  }
  return out
}

const ehRecusa = (x: unknown): x is Recusa => typeof (x as Recusa | null)?.erro === 'string' && typeof (x as Recusa).status === 'number'

/** Texto opcional: undefined = não mexe; '' ou null = limpa. */
function textoOpcional(v: unknown): string | null | undefined {
  if (v === undefined) return undefined
  if (v === null) return null
  return typeof v === 'string' ? (v.trim() || null) : undefined
}

/** Trava por tenant das mudanças de vínculo/ativo (último admin). */
async function travarCadastro(tx: Sql): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(tenant_atual()::text || ':cadastro-usuarios', 0))`
}

/** Todas as filiais citadas existem neste tenant? */
async function filiaisExistem(tx: Sql, vinculos: readonly Vinculo[]): Promise<boolean> {
  const ids = [...new Set(vinculos.map((v) => v.filialId).filter((x): x is string => x !== null))]
  if (ids.length === 0) return true
  const [l] = await tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM filial WHERE tenant_id = tenant_atual() AND id = ANY(${ids}::uuid[])`
  return (l?.n ?? 0) === ids.length
}

async function gravarVinculos(tx: Sql, usuarioId: string, vinculos: readonly Vinculo[]): Promise<void> {
  await tx`DELETE FROM usuario_filial WHERE tenant_id = tenant_atual() AND usuario_id = ${usuarioId}`
  for (const v of vinculos) {
    await tx`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel)
             VALUES (tenant_atual(), ${usuarioId}, ${v.filialId}, ${v.papel})`
  }
}

/** A linha de `usuario` do chamador precisa existir antes de `exigirPapel` (mesmo padrão de rotas-config). */
async function garantirUsuario(req: FastifyRequest): Promise<void> {
  if (req.tenantId && !req.atorStaff) await req.comTenant((tx) => garantirUsuarioId(tx, req))
}

const RESPOSTA_PROVEDOR: Record<Exclude<ResultadoOperacao['tipo'], 'ok'>, Recusa> = {
  nao_encontrado: recusa(404, 'identidade.usuario_nao_encontrado', 'Este usuário não tem login no provedor de identidade.'),
  senha_invalida: recusa(422, 'usuario.senha_invalida', 'A senha não atende à política: mínimo de 8 caracteres, com maiúscula, minúscula, número e símbolo.'),
  indisponivel: recusa(503, 'identidade.indisponivel', 'O provedor de identidade não está configurado no servidor.'),
  recusado: recusa(403, 'identidade.login_de_outra_conta', 'O login deste usuário não pertence a esta empresa. Fale com o suporte.'),
}

export interface OpcoesRotasUsuarios { readonly provedor: ProvedorIdentidade }

export async function rotasUsuarios(app: FastifyInstance, opcoes: OpcoesRotasUsuarios): Promise<void> {
  const { provedor } = opcoes
  const SO_ADMIN = { preHandler: [exigirTenant, garantirUsuario, exigirAdminAtribuido()] }

  /** Lista por cursor `(nome, id)`. Filtros: `busca` (nome/e-mail), `ativo`. */
  app.get<{ Querystring: { cursor?: string; busca?: string; ativo?: string } }>(
    '/v1/usuarios', SO_ADMIN,
    async (req, reply) => {
      let curNome: string | null = null, curId: string | null = null
      if (req.query.cursor) {
        const [nome, id] = Buffer.from(req.query.cursor, 'base64url').toString('utf8').split('§')
        if (nome === undefined || !id || !UUID.test(id)) return reply.code(422).send({ erro: 'cursor.invalido' })
        curNome = nome; curId = id
      }
      const busca = req.query.busca?.trim()
      const ativo = req.query.ativo === 'true' ? true : req.query.ativo === 'false' ? false : null
      const linhas = await req.comTenant((tx) => tx<{
        id: string; nome: string; email: string; telefone: string | null; cargo: string | null
        ativo: boolean; ultimo_login_em: Date | null
        papeis: { papel: string; filialId: string | null; filial: string | null }[]
      }[]>`
        SELECT u.id, u.nome, u.email, u.telefone, u.cargo, u.ativo, u.ultimo_login_em,
               coalesce((SELECT json_agg(json_build_object('papel', uf.papel, 'filialId', uf.filial_id, 'filial', f.nome)
                                         ORDER BY f.nome NULLS FIRST, uf.papel)
                           FROM usuario_filial uf
                           LEFT JOIN filial f ON f.tenant_id = uf.tenant_id AND f.id = uf.filial_id
                          WHERE uf.tenant_id = u.tenant_id AND uf.usuario_id = u.id), '[]'::json) AS papeis
          FROM usuario u
         WHERE u.tenant_id = tenant_atual() AND ${naoEhLinhaDeStaff(tx, 'u')}
           AND ${busca ? tx`(u.nome ILIKE ${'%' + busca + '%'} OR u.email ILIKE ${'%' + busca + '%'})` : tx`true`}
           AND ${ativo === null ? tx`true` : tx`u.ativo = ${ativo}`}
           AND ${curNome === null ? tx`true` : tx`(u.nome, u.id) > (${curNome}, ${curId}::uuid)`}
         ORDER BY u.nome ASC, u.id ASC
         LIMIT ${PAGINA + 1}`)
      const temMais = linhas.length > PAGINA
      const pagina = temMais ? linhas.slice(0, PAGINA) : linhas
      const ultimo = pagina[pagina.length - 1]
      return reply.send({
        itens: pagina.map((l) => ({
          id: l.id, nome: l.nome, email: l.email, telefone: l.telefone, cargo: l.cargo,
          ativo: l.ativo, ultimoLoginEm: l.ultimo_login_em, papeis: l.papeis,
        })),
        proximoCursor: temMais && ultimo ? Buffer.from(`${ultimo.nome}§${ultimo.id}`).toString('base64url') : null,
      })
    },
  )

  /**
   * Cria o usuário: login no provedor (convite por e-mail, ou senha temporária)
   * + `usuario` + `usuario_filial`, numa transação. ⚠️ O provedor é chamado
   * DEPOIS das validações e da checagem de e-mail no tenant, e ANTES do INSERT:
   * se o provedor recusar, nada foi gravado; se o INSERT falhar depois do
   * provedor criar, o login criado é desativado (compensação).
   */
  app.post<{ Body: { nome?: string; email?: string; telefone?: string; cargo?: string; papeis?: unknown; senhaTemporaria?: string } }>(
    '/v1/usuarios', SO_ADMIN,
    async (req, reply) => {
      const b = req.body ?? {}
      const nome = b.nome?.trim()
      const email = b.email?.trim().toLowerCase()
      if (!nome) return reply.code(422).send({ erro: 'usuario.nome_obrigatorio', mensagem: 'Informe o nome.', campos: ['nome'] })
      if (!email || !EMAIL.test(email)) return reply.code(422).send({ erro: 'usuario.email_invalido', mensagem: 'E-mail inválido.', campos: ['email'] })
      const vinculos = lerVinculos(b.papeis ?? [])
      if (ehRecusa(vinculos)) return reply.code(vinculos.status).send({ erro: vinculos.erro, mensagem: vinculos.mensagem, campos: ['papeis'] })
      if (b.senhaTemporaria !== undefined && (typeof b.senhaTemporaria !== 'string' || b.senhaTemporaria.length < SENHA_MINIMA)) {
        return reply.code(422).send({ ...RESPOSTA_PROVEDOR.senha_invalida, campos: ['senhaTemporaria'] })
      }
      const tenantId = req.tenantId!
      let loginCriado: AlvoIdentidade | null = null

      try {
        const r = await req.comTenant(async (tx): Promise<Recusa | { id: string }> => {
          await travarCadastro(tx)
          const [dup] = await tx`SELECT 1 FROM usuario WHERE tenant_id = tenant_atual() AND lower(email) = ${email}`
          if (dup) return recusa(409, 'usuario.email_duplicado', 'Já existe um usuário com este e-mail nesta empresa.')
          if (!(await filiaisExistem(tx, vinculos))) return recusa(422, 'usuario.filial_invalida', 'Filial não encontrada.')

          const criado = await provedor.criarUsuario({ email, nome, tenantId, senhaTemporaria: b.senhaTemporaria })
          // ⚠️ Já tem login no provedor (de outra empresa, do staff…): 409
          //    GENÉRICO, que não diz de quem é, e o login NUNCA é reaproveitado.
          if (criado.tipo === 'email_em_uso') {
            return recusa(409, 'usuario.email_indisponivel', 'Não é possível usar este e-mail. Use outro endereço.')
          }
          if (criado.tipo === 'senha_invalida') return RESPOSTA_PROVEDOR.senha_invalida
          if (criado.tipo === 'indisponivel') return RESPOSTA_PROVEDOR.indisponivel
          loginCriado = { sub: criado.sub, tenantId }

          const id = randomUUID()
          await tx`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email, telefone, cargo)
                   VALUES (tenant_atual(), ${id}, ${criado.sub}, ${nome}, ${email},
                           ${textoOpcional(b.telefone) ?? null}, ${textoOpcional(b.cargo) ?? null})`
          await gravarVinculos(tx, id, vinculos)
          await auditar(tx, {
            atorId: await atorDaRequisicao(tx, req), atorStaff: req.atorStaff ?? false,
            acao: 'usuario.criado', entidade: 'usuario', entidadeId: id,
            dados: { email, papeis: vinculos },
          })
          return { id }
        })
        if (ehRecusa(r)) return reply.code(r.status).send({ erro: r.erro, mensagem: r.mensagem })
        return reply.code(201).send({ id: r.id })
      } catch (e) {
        // ⚠️ Compensação: o login existe no provedor mas o vínculo não gravou.
        //    Desativado, ele não entra num tenant onde não existe usuário.
        if (loginCriado) await provedor.desativar(loginCriado).catch(() => undefined)
        throw e
      }
    },
  )

  /** Edita dados, papéis (substitui a lista) e ativo. E-mail não muda (é o login). */
  app.patch<{ Params: { id: string }; Body: { nome?: string; telefone?: string | null; cargo?: string | null; ativo?: boolean; papeis?: unknown } }>(
    '/v1/usuarios/:id', SO_ADMIN,
    async (req, reply) => {
      const id = req.params.id
      if (!UUID.test(id)) return reply.code(404).send({ erro: 'usuario.nao_encontrado' })
      const b = req.body ?? {}
      const nome = b.nome === undefined ? undefined : b.nome.trim()
      if (nome !== undefined && !nome) return reply.code(422).send({ erro: 'usuario.nome_obrigatorio', mensagem: 'O nome não pode ficar vazio.', campos: ['nome'] })
      if (b.ativo !== undefined && typeof b.ativo !== 'boolean') return reply.code(422).send({ erro: 'usuario.ativo_invalido', campos: ['ativo'] })
      const vinculos = b.papeis === undefined ? undefined : lerVinculos(b.papeis)
      if (vinculos !== undefined && ehRecusa(vinculos)) return reply.code(vinculos.status).send({ erro: vinculos.erro, mensagem: vinculos.mensagem, campos: ['papeis'] })
      const telefone = textoOpcional(b.telefone)
      const cargo = textoOpcional(b.cargo)
      if (nome === undefined && telefone === undefined && cargo === undefined && b.ativo === undefined && vinculos === undefined) {
        return reply.code(422).send({ erro: 'usuario.nada_a_mudar' })
      }

      const r = await req.comTenant(async (tx): Promise<Recusa | { provedor: ResultadoOperacao['tipo'] | null }> => {
        await travarCadastro(tx)
        const [atual] = await tx<{ email: string; ativo: boolean; cognito_sub: string | null; admin: boolean }[]>`
          SELECT u.email, u.ativo, u.cognito_sub,
                 EXISTS (SELECT 1 FROM usuario_filial uf
                          WHERE uf.tenant_id = u.tenant_id AND uf.usuario_id = u.id AND uf.papel = 'admin') AS admin
            FROM usuario u WHERE u.tenant_id = tenant_atual() AND u.id = ${id} AND ${naoEhLinhaDeStaff(tx, 'u')}`
        if (!atual) return recusa(404, 'usuario.nao_encontrado', 'Usuário não encontrado.')
        if (vinculos !== undefined && !(await filiaisExistem(tx, vinculos))) return recusa(422, 'usuario.filial_invalida', 'Filial não encontrada.')

        // ── O último admin ativo ──────────────────────────────────────────
        const ehAdminAtivo = atual.ativo && atual.admin
        const seraAtivo = b.ativo ?? atual.ativo
        const seraAdmin = vinculos === undefined ? atual.admin : vinculos.some((v) => v.papel === 'admin')
        if (ehAdminAtivo && !(seraAtivo && seraAdmin)) {
          const [outro] = await tx`
            SELECT 1 FROM usuario_filial uf
              JOIN usuario u ON u.tenant_id = uf.tenant_id AND u.id = uf.usuario_id
             WHERE uf.tenant_id = tenant_atual() AND uf.papel = 'admin' AND u.ativo AND u.id <> ${id}
             LIMIT 1`
          if (!outro) {
            return recusa(422, 'usuario.ultimo_admin',
              'Este é o último administrador ativo. Promova outra pessoa a administrador antes de rebaixar ou desativar esta.')
          }
        }

        // ⚠️ O banco é a autoridade (inativo não tem papel nem escopo na próxima
        //    requisição); o bloqueio no provedor é a segunda camada — impede o
        //    login. Resultado do provedor vai na resposta para a tela avisar.
        //    O login é localizado pelo `sub` da linha e conferido (tenant, grupo
        //    staff) ANTES de operar: `recusado` não grava nada, nem no banco.
        let resultadoProvedor: ResultadoOperacao['tipo'] | null = null
        if (b.ativo !== undefined && b.ativo !== atual.ativo && atual.cognito_sub) {
          const alvo = { sub: atual.cognito_sub, tenantId: req.tenantId! }
          resultadoProvedor = (b.ativo ? await provedor.reativar(alvo) : await provedor.desativar(alvo)).tipo
          if (resultadoProvedor === 'recusado') return RESPOSTA_PROVEDOR.recusado
        }

        await tx`UPDATE usuario SET
                   nome     = ${nome ?? tx`nome`},
                   telefone = ${telefone === undefined ? tx`telefone` : telefone},
                   cargo    = ${cargo === undefined ? tx`cargo` : cargo},
                   ativo    = ${b.ativo === undefined ? tx`ativo` : b.ativo}
                 WHERE tenant_id = tenant_atual() AND id = ${id}`
        if (vinculos !== undefined) await gravarVinculos(tx, id, vinculos)
        await auditar(tx, {
          atorId: await atorDaRequisicao(tx, req), atorStaff: req.atorStaff ?? false,
          acao: 'usuario.alterado', entidade: 'usuario', entidadeId: id,
          dados: {
            campos: Object.keys(b).filter((k) => k !== 'papeis' || vinculos !== undefined),
            ...(vinculos !== undefined ? { papeis: vinculos } : {}),
            ...(b.ativo !== undefined ? { ativo: b.ativo } : {}),
            ...(resultadoProvedor ? { provedor: resultadoProvedor } : {}),
          },
        })
        return { provedor: resultadoProvedor }
      })
      if (ehRecusa(r)) return reply.code(r.status).send({ erro: r.erro, mensagem: r.mensagem })
      return reply.send({ ok: true, provedor: r.provedor })
    },
  )

  /** Define uma senha temporária no provedor: o próximo login exige trocar. */
  app.post<{ Params: { id: string }; Body: { senhaTemporaria?: string } }>(
    '/v1/usuarios/:id/redefinir-senha', SO_ADMIN,
    async (req, reply) => {
      const id = req.params.id
      if (!UUID.test(id)) return reply.code(404).send({ erro: 'usuario.nao_encontrado' })
      const senha = req.body?.senhaTemporaria
      if (typeof senha !== 'string' || senha.length < SENHA_MINIMA) {
        return reply.code(422).send({ ...RESPOSTA_PROVEDOR.senha_invalida, campos: ['senhaTemporaria'] })
      }
      const r = await req.comTenant(async (tx): Promise<Recusa | null> => {
        const [u] = await tx<{ cognito_sub: string | null }[]>`
          SELECT u.cognito_sub FROM usuario u
           WHERE u.tenant_id = tenant_atual() AND u.id = ${id} AND ${naoEhLinhaDeStaff(tx, 'u')}`
        if (!u) return recusa(404, 'usuario.nao_encontrado', 'Usuário não encontrado.')
        if (!u.cognito_sub) return RESPOSTA_PROVEDOR.nao_encontrado
        // ⚠️ Pelo `sub` da linha — nunca pelo e-mail — e o adaptador confere
        //    tenant e grupo staff antes de tocar a senha.
        const res = await provedor.redefinirSenha({ sub: u.cognito_sub, tenantId: req.tenantId! }, senha)
        if (res.tipo !== 'ok') return RESPOSTA_PROVEDOR[res.tipo]
        await auditar(tx, {
          atorId: await atorDaRequisicao(tx, req), atorStaff: req.atorStaff ?? false,
          acao: 'usuario.senha_redefinida', entidade: 'usuario', entidadeId: id,
        })
        return null
      })
      if (r) return reply.code(r.status).send({ erro: r.erro, mensagem: r.mensagem })
      return reply.send({ ok: true })
    },
  )
}
