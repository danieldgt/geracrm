import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Sql } from '../../db/index.js'
import { subDoUsuario } from '../../plugins/tenant.js'
import { garantirUsuarioId } from '../atendimento/rotas-fila.js'
import { fragmentoNaFila } from '../atendimento/sla-handoff.js'

/**
 * ESCOPO DO USUÁRIO — O QUE uma pessoa enxerga dentro do tenant (raia D3).
 *
 * `papel.ts` responde "pode CONFIGURAR?"; este arquivo responde "quais
 * contatos, conversas, tarefas, pedidos e oportunidades ESTA pessoa vê?". É a
 * decisão única (skill geracrm-identidade-acesso: "centralize em um lugar só");
 * rota nenhuma replica a regra — chama os helpers daqui.
 *
 * ── A REGRA (decidirEscopo, pura) ──────────────────────────────────────────
 *
 *   1. Sessão de staff (PLT-05)                       → tudo (já auditada).
 *   2. Usuário inexistente ou INATIVO                  → carteira de ninguém
 *      (`usuarioId: null`): não vê nada. Nunca tudo.
 *   3. MODO FUNDADOR (tenant sem nenhum admin ativo)   → tudo — a MESMA regra de
 *      `papeisDoUsuario`: quem existe e está ativo vale admin.
 *   4. `admin` em qualquer filial                      → tudo.
 *   5. `gestor`/`supervisor` com `filial_id NULL`      → tudo (o NULL é "todas").
 *   6. `gestor`/`supervisor` com filiais               → filial (UNIÃO delas).
 *   7. Só `vendedor`/`atendente`, ou nenhum papel      → carteira do próprio.
 *
 *   ⚠️ Revalidado a CADA requisição, sem cache: papel retirado, filial trocada
 *      ou carteira transferida valem na próxima chamada.
 *
 * ── O QUE CADA ESCOPO VÊ (helpers de SQL) ──────────────────────────────────
 *
 *   CONTATO
 *     carteira → a carteira VIGENTE (`carteira_atribuicao.ate IS NULL`, a mesma
 *                vigência de rotas-carteira.ts) é do usuário; OU o cliente está
 *                EM ATENDIMENTO com ele agora (atendimento aberto de uma conversa
 *                do contato com atendente ou responsável = ele). ⚠️ Sem isto,
 *                quem assume da fila um cliente que não é da sua carteira não
 *                abriria a ficha nem o pedido do cliente que está atendendo.
 *     filial   → o mesmo "em atendimento comigo", mais: (a) `contato.filial_id`
 *                numa das filiais; OU (b) o dono vigente
 *                tem papel numa das filiais (`usuario_filial`); OU (c) o dono
 *                vigente é o próprio gestor; OU (d) o contato está SEM DONO e
 *                SEM filial.
 *       ⚠️ DECISÃO DE BORDA (d) — "sem dono": o contato não tem `filial_id`
 *          gravado hoje (nenhum caminho do produto o preenche; a coluna existe
 *          desde a 0008), então a filial vem do DONO. O órfão não tem dono e
 *          portanto não tem filial: escondê-lo trancaria o gestor fora da fila
 *          de distribuição (é ele quem atribui o órfão). A opção mais restritiva
 *          que NÃO tranca o gestor: gestor de qualquer filial vê os órfãos SEM
 *          filial do tenant. Órfão COM `filial_id` só aparece para a filial dele.
 *          Vendedor NÃO vê órfão (não é dele).
 *       ⚠️ Dono com papel só em `filial_id NULL` (todas) não pertence a filial
 *          específica: o cliente dele não aparece para o gestor de UMA filial.
 *   CONVERSA (alias fixo `cv`)
 *     carteira → contato visível; OU atendimento aberto com atendente ou
 *                responsável (handoff roteado) = o usuário; OU a conversa está
 *                NA FILA (mesma régua `fragmentoNaFila`) de um número que ele
 *                atende — `usuario_canal` com ele, ou número SEM ninguém
 *                vinculado (o mesmo fallback "todos atendem" da notificação).
 *                ⚠️ É o que preserva o fluxo de assumir: a fila continua visível
 *                a quem atende o número.
 *     filial   → o mesmo, mais: conversa de número (`canal_conectado.filial_id`)
 *                de uma das filiais, e a fila desses números.
 *   TAREFA     → responsável OU criador = o usuário (quem delega acompanha); filial:
 *                responsável com papel na filial; tarefa SEM responsável ("de
 *                ninguém", 0039) aparece se for avulsa ou se o contato dela for
 *                visível.
 *   PEDIDO     → `vendedor_id` = o usuário (filial: vendedor da filial); OU o
 *                contato é visível; OU a conversa onde nasceu (ADR-005) é
 *                visível. Pedido sem contato e sem vendedor (balcão
 *                avulso): só filial/tudo veem — é "sem dono", como o órfão.
 *   OPORTUNIDADE → contato visível; OU responsável = o usuário (filial:
 *                responsável da filial).
 *
 * ── ONDE VALE ──────────────────────────────────────────────────────────────
 *
 *   Só em REQUISIÇÃO HUMANA autenticada (`escopoDaRequisicao`). Workers,
 *   webhooks, o agente e `comTenantServico` NÃO chamam nada daqui — o escopo não
 *   pode mudar o que a máquina processa.
 *
 *   Fora do escopo = 404 (`nao_encontrado`), nunca 403: não revela existência.
 */

export type Escopo =
  | { readonly tipo: 'tudo' }
  | { readonly tipo: 'filial'; readonly filialIds: readonly string[]; readonly usuarioId: string }
  /** `usuarioId: null` = usuário inexistente/inativo: nada é dele, não vê nada. */
  | { readonly tipo: 'carteira'; readonly usuarioId: string | null }

/** O que a decisão precisa saber — lido do banco por `escopoDoUsuario`. */
export interface FatosDeAcesso {
  readonly staff: boolean
  /** `usuario.id` do chamador no tenant; null = não há linha. */
  readonly usuarioId: string | null
  readonly usuarioAtivo: boolean
  readonly tenantTemAdminAtivo: boolean
  readonly vinculos: readonly { readonly papel: string; readonly filialId: string | null }[]
}

const GESTAO = ['gestor', 'supervisor']

/** A decisão, PURA (testável sem banco). Ver a regra no topo do arquivo. */
export function decidirEscopo(f: FatosDeAcesso): Escopo {
  if (f.staff) return { tipo: 'tudo' }
  if (!f.usuarioId || !f.usuarioAtivo) return { tipo: 'carteira', usuarioId: null }
  if (!f.tenantTemAdminAtivo) return { tipo: 'tudo' }
  if (f.vinculos.some((v) => v.papel === 'admin')) return { tipo: 'tudo' }
  const gestao = f.vinculos.filter((v) => GESTAO.includes(v.papel))
  if (gestao.some((v) => v.filialId === null)) return { tipo: 'tudo' }
  const filialIds = [...new Set(gestao.map((v) => v.filialId).filter((id): id is string => id !== null))].sort()
  if (filialIds.length > 0) return { tipo: 'filial', filialIds, usuarioId: f.usuarioId }
  return { tipo: 'carteira', usuarioId: f.usuarioId }
}

/** Lê os fatos sob RLS do tenant da transação e decide. Não escreve. */
export async function escopoDoUsuario(
  tx: Sql, quem: { sub: string; atorStaff?: boolean | undefined },
): Promise<Escopo> {
  if (quem.atorStaff) return decidirEscopo({ staff: true, usuarioId: null, usuarioAtivo: false, tenantTemAdminAtivo: false, vinculos: [] })
  return lerEDecidir(tx, tx`u.cognito_sub = ${quem.sub}`)
}

/**
 * O escopo de OUTRA pessoa do tenant, pelo `usuario.id` — para decisões sobre um
 * destino (ex.: reatribuir a conversa a alguém que precisa poder atendê-la).
 * Mesma regra; nunca staff.
 */
export async function escopoDoUsuarioId(tx: Sql, usuarioId: string): Promise<Escopo> {
  return lerEDecidir(tx, tx`u.id = ${usuarioId}::uuid`)
}

async function lerEDecidir(tx: Sql, filtroUsuario: ReturnType<Sql>): Promise<Escopo> {
  const [l] = await tx<{
    id: string; ativo: boolean; tenant_tem_admin: boolean
    vinculos: { papel: string; filialId: string | null }[]
  }[]>`
    SELECT u.id, u.ativo,
           EXISTS (SELECT 1 FROM usuario_filial uf
                     JOIN usuario ua ON ua.tenant_id = uf.tenant_id AND ua.id = uf.usuario_id
                    WHERE uf.tenant_id = tenant_atual() AND uf.papel = 'admin' AND ua.ativo) AS tenant_tem_admin,
           coalesce((SELECT json_agg(json_build_object('papel', uf.papel, 'filialId', uf.filial_id))
                       FROM usuario_filial uf
                      WHERE uf.tenant_id = u.tenant_id AND uf.usuario_id = u.id), '[]'::json) AS vinculos
      FROM usuario u
     WHERE u.tenant_id = tenant_atual() AND ${filtroUsuario}`
  return decidirEscopo({
    staff: false,
    usuarioId: l?.id ?? null,
    usuarioAtivo: l?.ativo ?? false,
    tenantTemAdminAtivo: l?.tenant_tem_admin ?? false,
    vinculos: l?.vinculos ?? [],
  })
}

/**
 * O escopo de quem fez a REQUISIÇÃO. Chamar DENTRO do `comTenant` da rota.
 *
 * ⚠️ Garante a linha de `usuario` antes de ler (só INSERE quando falta — nunca
 *    atualiza numa leitura). A linha nasce no batimento do console
 *    (`garantirUsuarioId`) e as rotas de configuração já a garantem antes de
 *    `exigirPapel`; sem isto, a primeira leitura de um usuário recém-logado
 *    (antes do primeiro batimento) cairia em "inexistente" e veria a base vazia.
 *    Não dá acesso que o próprio batimento não daria: quem o tenant desativou
 *    continua inativo (o conflito não reativa).
 */
export async function escopoDaRequisicao(tx: Sql, req: FastifyRequest): Promise<Escopo> {
  if (req.atorStaff) return { tipo: 'tudo' }
  const sub = subDoUsuario(req)
  const [existe] = await tx`SELECT 1 FROM usuario WHERE tenant_id = tenant_atual() AND cognito_sub = ${sub}`
  if (!existe) await garantirUsuarioId(tx, req)
  return escopoDoUsuario(tx, { sub, atorStaff: false })
}

// ─────────────────────────── helpers de SQL ───────────────────────────

const ALIAS = /^[a-z_][a-z0-9_]*$/

/** Alias de tabela inlinado no SQL — só identificador simples, nunca entrada do usuário. */
function alias(tx: Sql, a: string) {
  if (!ALIAS.test(a)) throw new Error(`escopo: alias inválido "${a}"`)
  return tx.unsafe(a)
}

/** O usuário `u` tem papel numa das filiais? (`col` = expressão do usuario_id). */
function usuarioDaFilial(tx: Sql, tenantCol: ReturnType<typeof alias>, col: ReturnType<typeof alias>, filialIds: readonly string[]) {
  return tx`EXISTS (SELECT 1 FROM usuario_filial esc_uf
                     WHERE esc_uf.tenant_id = ${tenantCol} AND esc_uf.usuario_id = ${col}
                       AND esc_uf.filial_id = ANY(${[...filialIds]}::uuid[]))`
}

/** Contato visível no escopo (alias da tabela `contato`, padrão `c`). */
export function condicaoContato(tx: Sql, escopo: Escopo, aliasContato = 'c') {
  if (escopo.tipo === 'tudo') return tx`true`
  if (escopo.usuarioId === null) return tx`false`
  const a = alias(tx, aliasContato)
  // Em atendimento COMIGO agora: quem assumiu a conversa (ou recebeu o handoff)
  // precisa abrir a ficha e montar o pedido do cliente que está atendendo.
  const emAtendimentoComigo = tx`EXISTS (
    SELECT 1 FROM conversa esc_cv
      JOIN atendimento esc_at ON esc_at.tenant_id = esc_cv.tenant_id AND esc_at.conversa_id = esc_cv.id
     WHERE esc_cv.tenant_id = ${a}.tenant_id AND esc_cv.contato_id = ${a}.id
       AND esc_at.estado <> 'encerrado'
       AND (esc_at.atendente_id = ${escopo.usuarioId}::uuid OR esc_at.responsavel_id = ${escopo.usuarioId}::uuid))`
  if (escopo.tipo === 'carteira') {
    return tx`(
      EXISTS (SELECT 1 FROM carteira_atribuicao esc_ca
               WHERE esc_ca.tenant_id = ${a}.tenant_id AND esc_ca.contato_id = ${a}.id
                 AND esc_ca.ate IS NULL AND esc_ca.usuario_id = ${escopo.usuarioId}::uuid)
      OR ${emAtendimentoComigo})`
  }
  const filiais = [...escopo.filialIds]
  return tx`(
    ${emAtendimentoComigo}
    OR ${a}.filial_id = ANY(${filiais}::uuid[])
    OR EXISTS (SELECT 1 FROM carteira_atribuicao esc_ca
                WHERE esc_ca.tenant_id = ${a}.tenant_id AND esc_ca.contato_id = ${a}.id AND esc_ca.ate IS NULL
                  AND (esc_ca.usuario_id = ${escopo.usuarioId}::uuid
                       OR ${usuarioDaFilial(tx, tx.unsafe('esc_ca.tenant_id'), tx.unsafe('esc_ca.usuario_id'), filiais)}))
    OR (${a}.filial_id IS NULL AND NOT EXISTS (
          SELECT 1 FROM carteira_atribuicao esc_ca
           WHERE esc_ca.tenant_id = ${a}.tenant_id AND esc_ca.contato_id = ${a}.id
             AND esc_ca.ate IS NULL AND esc_ca.usuario_id IS NOT NULL)))`
}

/**
 * Conversa visível no escopo. ⚠️ Alias FIXO `cv`: a régua da fila
 * (`fragmentoNaFila`) é escrita sobre `cv`, e reusá-la é o que mantém "o que é
 * fila" uma definição só.
 */
export function condicaoConversa(tx: Sql, escopo: Escopo) {
  if (escopo.tipo === 'tudo') return tx`true`
  if (escopo.usuarioId === null) return tx`false`
  const u = escopo.usuarioId
  const doNumeroDaFilial = escopo.tipo === 'filial'
    ? tx`EXISTS (SELECT 1 FROM canal_conectado esc_cc
                  WHERE esc_cc.tenant_id = cv.tenant_id AND esc_cc.id = cv.canal_id
                    AND esc_cc.filial_id = ANY(${[...escopo.filialIds]}::uuid[]))`
    : tx`false`
  return tx`(
    EXISTS (SELECT 1 FROM contato esc_ct
             WHERE esc_ct.tenant_id = cv.tenant_id AND esc_ct.id = cv.contato_id
               AND ${condicaoContato(tx, escopo, 'esc_ct')})
    OR EXISTS (SELECT 1 FROM atendimento esc_at
                WHERE esc_at.tenant_id = cv.tenant_id AND esc_at.conversa_id = cv.id
                  AND esc_at.estado <> 'encerrado'
                  AND (esc_at.atendente_id = ${u}::uuid OR esc_at.responsavel_id = ${u}::uuid))
    OR ${doNumeroDaFilial}
    OR (${fragmentoNaFila(tx)} AND (
          EXISTS (SELECT 1 FROM usuario_canal esc_uc
                   WHERE esc_uc.tenant_id = cv.tenant_id AND esc_uc.canal_id = cv.canal_id
                     AND esc_uc.usuario_id = ${u}::uuid)
          OR NOT EXISTS (SELECT 1 FROM usuario_canal esc_uc
                          WHERE esc_uc.tenant_id = cv.tenant_id AND esc_uc.canal_id = cv.canal_id))))`
}

/** Contato (por id numa coluna) visível — para tabelas que apontam para contato. */
function contatoDaColunaVisivel(tx: Sql, escopo: Escopo, tenantCol: ReturnType<typeof alias>, contatoCol: ReturnType<typeof alias>) {
  return tx`EXISTS (SELECT 1 FROM contato esc_ct
                     WHERE esc_ct.tenant_id = ${tenantCol} AND esc_ct.id = ${contatoCol}
                       AND ${condicaoContato(tx, escopo, 'esc_ct')})`
}

/** Tarefa visível no escopo (alias padrão `t`). */
export function condicaoTarefa(tx: Sql, escopo: Escopo, aliasTarefa = 't') {
  if (escopo.tipo === 'tudo') return tx`true`
  if (escopo.usuarioId === null) return tx`false`
  const a = alias(tx, aliasTarefa)
  const tenantCol = tx.unsafe(`${aliasTarefa}.tenant_id`)
  const daFilial = escopo.tipo === 'filial'
    ? usuarioDaFilial(tx, tenantCol, tx.unsafe(`${aliasTarefa}.responsavel_id`), escopo.filialIds)
    : tx`false`
  return tx`(
    ${a}.responsavel_id = ${escopo.usuarioId}::uuid
    OR ${a}.criado_por = ${escopo.usuarioId}::uuid
    OR ${daFilial}
    OR (${a}.responsavel_id IS NULL AND (
          ${a}.contato_id IS NULL
          OR ${contatoDaColunaVisivel(tx, escopo, tenantCol, tx.unsafe(`${aliasTarefa}.contato_id`))})))`
}

/** Pedido visível no escopo (alias padrão `p`). */
export function condicaoPedido(tx: Sql, escopo: Escopo, aliasPedido = 'p') {
  if (escopo.tipo === 'tudo') return tx`true`
  if (escopo.usuarioId === null) return tx`false`
  const a = alias(tx, aliasPedido)
  const tenantCol = tx.unsafe(`${aliasPedido}.tenant_id`)
  const daFilial = escopo.tipo === 'filial'
    ? tx`(${usuarioDaFilial(tx, tenantCol, tx.unsafe(`${aliasPedido}.vendedor_id`), escopo.filialIds)}
          OR (${a}.contato_id IS NULL AND ${a}.vendedor_id IS NULL))`
    : tx`false`
  return tx`(
    ${a}.vendedor_id = ${escopo.usuarioId}::uuid
    OR ${daFilial}
    OR (${a}.contato_id IS NOT NULL
        AND ${contatoDaColunaVisivel(tx, escopo, tenantCol, tx.unsafe(`${aliasPedido}.contato_id`))})
    OR (${a}.conversa_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM conversa cv
           WHERE cv.tenant_id = ${a}.tenant_id AND cv.id = ${a}.conversa_id
             AND ${condicaoConversa(tx, escopo)})))`
}

/** Oportunidade do funil visível no escopo (alias padrão `o`). */
export function condicaoOportunidade(tx: Sql, escopo: Escopo, aliasOportunidade = 'o') {
  if (escopo.tipo === 'tudo') return tx`true`
  if (escopo.usuarioId === null) return tx`false`
  const a = alias(tx, aliasOportunidade)
  const tenantCol = tx.unsafe(`${aliasOportunidade}.tenant_id`)
  const daFilial = escopo.tipo === 'filial'
    ? usuarioDaFilial(tx, tenantCol, tx.unsafe(`${aliasOportunidade}.responsavel_id`), escopo.filialIds)
    : tx`false`
  return tx`(
    ${a}.responsavel_id = ${escopo.usuarioId}::uuid
    OR ${daFilial}
    OR ${contatoDaColunaVisivel(tx, escopo, tenantCol, tx.unsafe(`${aliasOportunidade}.contato_id`))})`
}

/**
 * Evento da agenda visível no escopo (alias padrão `e`). O evento não tem carteira
 * própria: quem decide é o RESPONSÁVEL. `filial` = responsável com papel numa das
 * filiais do escopo — a mesma régua de "alguém da filial" de `condicaoTarefa`.
 */
export function condicaoEvento(tx: Sql, escopo: Escopo, aliasEvento = 'e') {
  if (escopo.tipo === 'tudo') return tx`true`
  if (escopo.usuarioId === null) return tx`false`
  if (escopo.tipo === 'carteira') return tx`${alias(tx, aliasEvento)}.responsavel_id = ${escopo.usuarioId}::uuid`
  return usuarioDaFilial(tx, tx.unsafe(`${aliasEvento}.tenant_id`), tx.unsafe(`${aliasEvento}.responsavel_id`), escopo.filialIds)
}

// ─────────────────── checagens por id (detalhe → 404) ───────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * O contato está no escopo? Com escopo `tudo` responde `true` SEM consultar —
 * a rota segue com a checagem de existência que já fazia. Id malformado fora de
 * `tudo` = fora (a rota responde 404, não 500).
 */
export async function contatoNoEscopo(tx: Sql, escopo: Escopo, contatoId: string): Promise<boolean> {
  if (escopo.tipo === 'tudo') return true
  if (!UUID.test(contatoId)) return false
  const [l] = await tx`SELECT 1 FROM contato c
                        WHERE c.tenant_id = tenant_atual() AND c.id = ${contatoId}
                          AND ${condicaoContato(tx, escopo, 'c')}`
  return Boolean(l)
}

/** A conversa está no escopo? Mesma convenção de `contatoNoEscopo`. */
export async function conversaNoEscopo(tx: Sql, escopo: Escopo, conversaId: string): Promise<boolean> {
  if (escopo.tipo === 'tudo') return true
  if (!UUID.test(conversaId)) return false
  const [l] = await tx`SELECT 1 FROM conversa cv
                        WHERE cv.tenant_id = tenant_atual() AND cv.id = ${conversaId}
                          AND ${condicaoConversa(tx, escopo)}`
  return Boolean(l)
}

/**
 * O usuário `usuarioId` PODE ATENDER esta conversa? Para o destino de uma
 * reatribuição: ele precisa ter acesso ao cliente OU ao número pela regra de
 * escopo — senão a gestão colocaria um cliente nas mãos de quem não o veria
 * (antes da reatribuição) nem atende aquele número.
 *
 *   tudo     → sim;
 *   inativo  → não;
 *   senão    → o contato está no escopo dele, OU ele atende o número
 *              (`usuario_canal` com ele, ou número sem ninguém vinculado), OU
 *              (gestor de filial) o número é de uma das filiais dele.
 *
 * ⚠️ Não conta "atendimento aberto com ele": é justamente o que a reatribuição
 *    vai criar.
 */
export async function podeAtenderConversa(tx: Sql, usuarioId: string, conversaId: string): Promise<boolean> {
  const escopo = await escopoDoUsuarioId(tx, usuarioId)
  if (escopo.tipo === 'tudo') return true
  if (escopo.usuarioId === null || !UUID.test(conversaId)) return false
  const u = escopo.usuarioId
  const doNumeroDaFilial = escopo.tipo === 'filial'
    ? tx`EXISTS (SELECT 1 FROM canal_conectado esc_cc
                  WHERE esc_cc.tenant_id = cv.tenant_id AND esc_cc.id = cv.canal_id
                    AND esc_cc.filial_id = ANY(${[...escopo.filialIds]}::uuid[]))`
    : tx`false`
  const [l] = await tx`
    SELECT 1 FROM conversa cv
     WHERE cv.tenant_id = tenant_atual() AND cv.id = ${conversaId}
       AND (EXISTS (SELECT 1 FROM contato esc_ct
                     WHERE esc_ct.tenant_id = cv.tenant_id AND esc_ct.id = cv.contato_id
                       AND ${condicaoContato(tx, escopo, 'esc_ct')})
            OR EXISTS (SELECT 1 FROM usuario_canal esc_uc
                        WHERE esc_uc.tenant_id = cv.tenant_id AND esc_uc.canal_id = cv.canal_id AND esc_uc.usuario_id = ${u}::uuid)
            OR NOT EXISTS (SELECT 1 FROM usuario_canal esc_uc
                            WHERE esc_uc.tenant_id = cv.tenant_id AND esc_uc.canal_id = cv.canal_id)
            OR ${doNumeroDaFilial})`
  return Boolean(l)
}

/** O pedido está no escopo? Mesma convenção de `contatoNoEscopo`. */
export async function pedidoNoEscopo(tx: Sql, escopo: Escopo, pedidoId: string): Promise<boolean> {
  if (escopo.tipo === 'tudo') return true
  if (!UUID.test(pedidoId)) return false
  const [l] = await tx`SELECT 1 FROM pedido p
                        WHERE p.tenant_id = tenant_atual() AND p.id = ${pedidoId}
                          AND ${condicaoPedido(tx, escopo, 'p')}`
  return Boolean(l)
}

/**
 * Pode ser o RESPONSÁVEL de um evento escrito por este escopo? `tudo` → sim;
 * `carteira` → só ele mesmo; `filial` → ele mesmo ou alguém com papel numa das
 * filiais. Quem não existe ou está inativo (`usuarioId: null`) → não. Não confere
 * se o usuário está ativo: quem chama faz essa checagem junto da existência.
 */
export async function responsavelNoEscopo(tx: Sql, escopo: Escopo, usuarioId: string): Promise<boolean> {
  if (escopo.tipo === 'tudo') return true
  if (escopo.usuarioId === null || !UUID.test(usuarioId)) return false
  if (usuarioId === escopo.usuarioId) return true
  if (escopo.tipo === 'carteira') return false
  const [l] = await tx`SELECT 1 FROM usuario_filial esc_uf
                        WHERE esc_uf.tenant_id = tenant_atual() AND esc_uf.usuario_id = ${usuarioId}::uuid
                          AND esc_uf.filial_id = ANY(${[...escopo.filialIds]}::uuid[])
                        LIMIT 1`
  return Boolean(l)
}

const NO_ESCOPO = { contato: contatoNoEscopo, conversa: conversaNoEscopo, pedido: pedidoNoEscopo } as const
/** O MESMO código que cada rota já usava para inexistente — fora do escopo é indistinguível. */
const NAO_ENCONTRADO = { contato: 'contato.nao_encontrado', conversa: 'conversa.nao_encontrada', pedido: 'pedido.nao_encontrado' } as const

/**
 * preHandler: o recurso do parâmetro de rota (`:id` por padrão) precisa estar no
 * escopo de quem chama — senão 404 tipificado,
 * idêntico ao de inexistente (`NAO_ENCONTRADO`). Para as sub-rotas (`/v1/contatos/:id/telefones`…)
 * que não leem o recurso inteiro.
 *
 *   app.post('/v1/contatos/:id/telefones', { preHandler: [exigirTenant, exigirNoEscopo('contato')] }, ...)
 *
 * ⚠️ Depois de `exigirTenant` (precisa do tenant). Escopo `tudo` não consulta:
 *    a rota segue com a checagem de existência que já fazia.
 */
export function exigirNoEscopo(recurso: keyof typeof NO_ESCOPO, param = 'id') {
  return async function exigirNoEscopoHandler(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
    const id = String((req.params as Record<string, unknown> | undefined)?.[param] ?? '')
    const dentro = await req.comTenant(async (tx) => NO_ESCOPO[recurso](tx, await escopoDaRequisicao(tx, req), id))
    if (dentro) return undefined
    // ⚠️ `return reply`: em hook async, é o que diz ao Fastify que a resposta já saiu.
    return reply.code(404).send({ erro: NAO_ENCONTRADO[recurso] })
  }
}
