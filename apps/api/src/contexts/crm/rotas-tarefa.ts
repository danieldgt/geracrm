import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { ehTipoTarefa, semProximoPasso } from '@geracrm/shared'
import type { Sql } from '../../db/index.js'
import { exigirTenant, subDoUsuario } from '../../plugins/tenant.js'
import { garantirUsuarioId } from '../atendimento/rotas-fila.js'
import { auditar } from '../plataforma/auditoria.js'
import { fusoSeguro } from '../plataforma/fuso.js'
import { atendePapel, exigirPapel, papeisDoUsuario } from '../plataforma/papel.js'
import { condicaoContato, condicaoTarefa, contatoNoEscopo, escopoDaRequisicao, type Escopo } from '../plataforma/escopo.js'
import { moduloAtivo } from '../plataforma/modulos.js'

const PAGINA = 30
export const LOTE_MAX = 500
const CONSULTA_MAX = 200
const RESULTADO_MAX = 2000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DIA = /^\d{4}-\d{2}-\d{2}$/
// Full-precision UTC text of a timestamptz (microseconds), as produced by Postgres `to_char` below.
const CURSOR_EM = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/
const ISO_DATA_HORA = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/

/** Real calendar date check: 2026-02-31 matches the shape but is not a date. */
function diaReal(v: string): boolean {
  if (!DIA.test(v)) return false
  const [a, m, d] = v.split('-').map(Number) as [number, number, number]
  const dt = new Date(Date.UTC(a, m - 1, d))
  return dt.getUTCFullYear() === a && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

const uuid = z.string().regex(UUID)
const dia = z.string().refine(diaReal)
const iso = z.string().refine((v) => ISO_DATA_HORA.test(v) && diaReal(v.slice(0, 10)) && !Number.isNaN(Date.parse(v)))
const tipoSchema = z.string().refine(ehTipoTarefa)
const SITUACOES = ['abertas', 'atrasadas', 'vencidas', 'hoje', 'semana', 'concluidas'] as const

const consultaLista = z.object({
  situacao: z.enum(SITUACOES).optional(), contatoId: uuid.optional(), tipo: tipoSchema.optional(),
  responsavelId: uuid.optional(), q: z.string().max(200).optional(), de: dia.optional(), ate: dia.optional(),
  cursor: z.string().max(300).optional(),
})
const consultaContadores = z.object({ responsavelId: uuid.optional() })
const consultaSemProximoPasso = z.object({ contatoIds: z.string().max(CONSULTA_MAX * 40).optional() })
const corpoTarefa = z.object({
  contatoId: uuid.nullish(), titulo: z.string().trim().min(1).max(200), descricao: z.string().max(5000).nullish(),
  venceEm: iso, tipo: tipoSchema.optional(), responsavelId: uuid.nullish(),
})
export const corpoLote = corpoTarefa.omit({ contatoId: true }).extend({ contatoIds: z.array(uuid).min(1).max(LOTE_MAX) })
const corpoConcluir = z.object({ resultado: z.string().trim().max(RESULTADO_MAX).nullish() }).nullish()
const paramId = z.object({ id: uuid })

/** Error code per invalid field (stable for the console); `campos` lists every offending field. */
const CODIGO_POR_CAMPO: Record<string, string> = {
  titulo: 'tarefa.titulo_obrigatorio', venceEm: 'tarefa.vencimento_invalido', tipo: 'tarefa.tipo_invalido',
  responsavelId: 'tarefa.responsavel_invalido', contatoId: 'tarefa.contato_invalido', contatoIds: 'tarefa.id_invalido',
  resultado: 'tarefa.resultado_grande', cursor: 'cursor.invalido', de: 'tarefa.periodo_invalido', ate: 'tarefa.periodo_invalido',
  situacao: 'tarefa.situacao_invalida', q: 'tarefa.busca_invalida', descricao: 'tarefa.descricao_invalida',
}

function entradaInvalida(reply: FastifyReply, e: z.ZodError): FastifyReply {
  const campos = [...new Set(e.issues.map((i) => String(i.path[0] ?? '')).filter(Boolean))]
  const primeiro = e.issues[0]
  let erro = CODIGO_POR_CAMPO[campos[0] ?? ''] ?? 'tarefa.entrada_invalida'
  if (campos[0] === 'contatoIds' && primeiro?.code === 'too_small') erro = 'tarefa.lote_vazio'
  if (campos[0] === 'contatoIds' && primeiro?.code === 'too_big') erro = 'tarefa.lote_grande'
  return reply.code(422).send({ erro, mensagem: 'Dados da tarefa inválidos.', campos })
}

/** Cursor = base64url("<vence_em µs UTC>§<id>"); anything else is malformed. */
function lerCursor(bruto: string | undefined): { em: string; id: string } | null | 'invalido' {
  if (!bruto) return null
  const [em, id, resto] = Buffer.from(bruto, 'base64url').toString('utf8').split('§')
  if (resto !== undefined || !em || !id || !CURSOR_EM.test(em) || !diaReal(em.slice(0, 10)) || Number.isNaN(Date.parse(em)) || !UUID.test(id)) return 'invalido'
  return { em, id }
}

/** Limites de "hoje" e "esta semana" no fuso do tenant, calculados com o `now()` do BANCO. */
interface Limites { fuso: string; inicioDia: Date; fimDia: Date; inicioSemana: Date; fimSemana: Date }

async function limitesDoTenant(tx: Sql): Promise<Limites> {
  const [t] = await tx<{ fuso: string | null }[]>`SELECT fuso FROM tenant WHERE id = tenant_atual()`
  // ⚠️ Fuso validado em TS antes de ir para o AT TIME ZONE: fuso inválido derrubaria a consulta.
  const fuso = fusoSeguro(t?.fuso)
  const [l] = await tx<{ inicio_dia: Date; fim_dia: Date; inicio_semana: Date; fim_semana: Date }[]>`
    WITH local AS (SELECT now() AT TIME ZONE ${fuso}::text AS agora)
    SELECT (date_trunc('day', agora)  AT TIME ZONE ${fuso}::text) AS inicio_dia,
           ((date_trunc('day', agora) + interval '1 day') AT TIME ZONE ${fuso}::text) AS fim_dia,
           (date_trunc('week', agora) AT TIME ZONE ${fuso}::text) AS inicio_semana,
           ((date_trunc('week', agora) + interval '7 days') AT TIME ZONE ${fuso}::text) AS fim_semana
      FROM local`
  return { fuso, inicioDia: l!.inicio_dia, fimDia: l!.fim_dia, inicioSemana: l!.inicio_semana, fimSemana: l!.fim_semana }
}

const escaparLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`)

/**
 * A tarefa está no escopo do usuário (D3)? Com escopo `tudo` não consulta (a rota
 * segue com as respostas de sempre). Fora do escopo = 404, como inexistente.
 */
async function tarefaNoEscopo(tx: Sql, escopo: Escopo, id: string): Promise<boolean> {
  if (escopo.tipo === 'tudo') return true
  if (!UUID.test(id)) return false
  const [l] = await tx`SELECT 1 FROM tarefa t
                        WHERE t.tenant_id = tenant_atual() AND t.id = ${id} AND ${condicaoTarefa(tx, escopo, 't')}`
  return Boolean(l)
}

/**
 * Uma tarefa por contato, na transação do chamador. Só contatos do tenant (RLS) E do
 * escopo do chamador (D3): ids desconhecidos ou fora do escopo são ignorados — quem
 * chama conta o que sobrou. Regra única do `/v1/tarefas/lote` e da ação em massa
 * "criar tarefa" da lista de contatos.
 */
export async function criarTarefasEmLote(
  tx: Sql, escopo: Escopo, atorId: string, ids: readonly string[],
  v: { titulo: string; descricao?: string | null | undefined; venceEm: string; tipo: string; responsavelId?: string | null | undefined },
): Promise<{ id: string }[]> {
  return tx<{ id: string }[]>`
    INSERT INTO tarefa (tenant_id, id, contato_id, responsavel_id, titulo, descricao, vence_em, criado_por, tipo)
    SELECT tenant_atual(), gen_random_uuid(), c.id, ${v.responsavelId ?? atorId}, ${v.titulo}, ${v.descricao?.trim() || null},
           ${v.venceEm}, ${atorId}, ${v.tipo}
      FROM contato c
     WHERE c.tenant_id = tenant_atual() AND c.id = ANY(${[...ids]}::uuid[])
       AND ${condicaoContato(tx, escopo, 'c')}
    RETURNING id`
}

/** O responsável informado existe neste tenant? (RLS) */
export async function responsavelDoTenantExiste(tx: Sql, id: string): Promise<boolean> {
  const [u] = await tx`SELECT 1 FROM usuario WHERE tenant_id = tenant_atual() AND id = ${id}`
  return !!u
}

/**
 * Tarefas de follow-up. ⚠️ "Situação" é derivada, no fuso do tenant:
 *   • abertas    = estado 'aberta'
 *   • atrasadas  = 'aberta' E vence_em < now()   (alias legado: 'vencidas')
 *   • hoje       = 'aberta' E vence_em dentro do dia local de hoje — SÓ o dia: a tarefa
 *                  de ontem ainda aberta NÃO aparece em `hoje`, aparece em `atrasadas`
 *                  (decisão intencional; fixada em tarefa.test.ts)
 *   • semana     = 'aberta' E vence_em dentro da semana local (segunda a domingo)
 *   • concluidas
 * Ordena por vencimento (mais urgente primeiro). Cursor por (vence_em, id), com o
 * vencimento em microssegundos (texto do próprio Postgres) para não perder a fronteira.
 *
 * `responsavel_id` NULL = de ninguém: aparece para todos — o filtro `responsavelId` e os
 * contadores por responsável incluem essas tarefas. Por padrão a API grava quem criou.
 *
 * Toda entrada passa por um schema Zod (422 com `campos`); `:id` que não é UUID → 404.
 * Autorização: criar em lote exige gestor/supervisor/admin; concluir/cancelar vale para o
 * responsável, o criador ou gestor/supervisor/admin (403 para os demais). Ambos são auditados.
 */
export async function rotasTarefa(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: Record<string, unknown> }>(
    '/v1/tarefas', { preHandler: exigirTenant },
    async (req, reply) => {
      const parsed = consultaLista.safeParse(req.query)
      if (!parsed.success) return entradaInvalida(reply, parsed.error)
      const { situacao, contatoId, tipo, responsavelId, de, ate } = parsed.data
      const q = parsed.data.q?.trim() || null
      const cur = lerCursor(parsed.data.cursor)
      if (cur === 'invalido') return reply.code(422).send({ erro: 'cursor.invalido', campos: ['cursor'] })

      const linhas = await req.comTenant(async (tx) => {
        const lim = await limitesDoTenant(tx)
        // ⚠️ Escopo (D3): só as tarefas que a pessoa enxerga (ver condicaoTarefa).
        const escopo = await escopoDaRequisicao(tx, req)
        const filtroSituacao =
          situacao === 'concluidas' ? tx`t.estado = 'concluida'`
          : situacao === 'vencidas' || situacao === 'atrasadas' ? tx`t.estado = 'aberta' AND t.vence_em < now()`
          : situacao === 'hoje'     ? tx`t.estado = 'aberta' AND t.vence_em >= ${lim.inicioDia} AND t.vence_em < ${lim.fimDia}`
          : situacao === 'semana'   ? tx`t.estado = 'aberta' AND t.vence_em >= ${lim.inicioSemana} AND t.vence_em < ${lim.fimSemana}`
          : situacao === 'abertas'  ? tx`t.estado = 'aberta'`
          : tx`t.estado <> 'cancelada'`
        return tx<{
          id: string; titulo: string; descricao: string | null; vence_em: Date; vence_em_cursor: string; estado: string; tipo: string
          resultado: string | null; concluida_em: Date | null; contato_id: string | null; contato: string | null
          responsavel_id: string | null; responsavel: string | null
        }[]>`
          SELECT t.id, t.titulo, t.descricao, t.vence_em,
                 to_char(t.vence_em AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS vence_em_cursor,
                 t.estado, t.tipo, t.resultado, t.concluida_em, t.contato_id,
                 c.nome AS contato, t.responsavel_id, u.nome AS responsavel
            FROM tarefa t
            LEFT JOIN contato c ON c.tenant_id = t.tenant_id AND c.id = t.contato_id
            LEFT JOIN usuario u ON u.tenant_id = t.tenant_id AND u.id = t.responsavel_id
           WHERE t.tenant_id = tenant_atual() AND ${filtroSituacao}
             AND ${contatoId ? tx`t.contato_id = ${contatoId}` : tx`true`}
             AND ${tipo ? tx`t.tipo = ${tipo}` : tx`true`}
             AND ${responsavelId ? tx`(t.responsavel_id = ${responsavelId} OR t.responsavel_id IS NULL)` : tx`true`}
             AND ${condicaoTarefa(tx, escopo, 't')}
             AND ${q ? tx`(t.titulo ILIKE ${'%' + escaparLike(q) + '%'} OR c.nome ILIKE ${'%' + escaparLike(q) + '%'})` : tx`true`}
             AND ${de ? tx`t.vence_em >= (${de}::date::timestamp AT TIME ZONE ${lim.fuso}::text)` : tx`true`}
             AND ${ate ? tx`t.vence_em < ((${ate}::date + 1)::timestamp AT TIME ZONE ${lim.fuso}::text)` : tx`true`}
             -- ⚠️ ::text::timestamptz — a bare ::timestamptz makes the driver parse the string into a JS Date and drop microseconds.
             AND ${cur === null ? tx`true` : tx`(t.vence_em, t.id) > (${cur.em}::text::timestamptz, ${cur.id}::uuid)`}
           ORDER BY t.vence_em ASC, t.id ASC LIMIT ${PAGINA + 1}`
      })
      const temMais = linhas.length > PAGINA
      const pagina = temMais ? linhas.slice(0, PAGINA) : linhas
      const ultimo = pagina[pagina.length - 1]
      const agora = Date.now()
      return reply.send({
        itens: pagina.map((l) => ({
          id: l.id, titulo: l.titulo, descricao: l.descricao, venceEm: l.vence_em, estado: l.estado, tipo: l.tipo,
          resultado: l.resultado, concluidaEm: l.concluida_em, contatoId: l.contato_id, contato: l.contato,
          responsavelId: l.responsavel_id, responsavel: l.responsavel,
          vencida: l.estado === 'aberta' && l.vence_em.getTime() < agora,
        })),
        proximoCursor: temMais && ultimo
          ? Buffer.from(`${ultimo.vence_em_cursor}§${ultimo.id}`).toString('base64url') : null,
      })
    },
  )

  // Screen cards: count of OPEN tasks in the tenant timezone (unowned tasks count for everyone).
  app.get<{ Querystring: Record<string, unknown> }>(
    '/v1/tarefas/contadores', { preHandler: exigirTenant },
    async (req, reply) => {
      const parsed = consultaContadores.safeParse(req.query)
      if (!parsed.success) return entradaInvalida(reply, parsed.error)
      const { responsavelId } = parsed.data
      const c = await req.comTenant(async (tx) => {
        const lim = await limitesDoTenant(tx)
        // ⚠️ Os cartões contam o que a lista MOSTRA (escopo D3).
        const escopo = await escopoDaRequisicao(tx, req)
        const [r] = await tx<{ pendentes: number; atrasadas: number; hoje: number; semana: number }[]>`
          SELECT count(*)::int AS pendentes,
                 (count(*) FILTER (WHERE t.vence_em < now()))::int AS atrasadas,
                 (count(*) FILTER (WHERE t.vence_em >= ${lim.inicioDia} AND t.vence_em < ${lim.fimDia}))::int AS hoje,
                 (count(*) FILTER (WHERE t.vence_em >= ${lim.inicioSemana} AND t.vence_em < ${lim.fimSemana}))::int AS semana
            FROM tarefa t
           WHERE t.tenant_id = tenant_atual() AND t.estado = 'aberta'
             AND ${responsavelId ? tx`(t.responsavel_id = ${responsavelId} OR t.responsavel_id IS NULL)` : tx`true`}
             AND ${condicaoTarefa(tx, escopo, 't')}`
        return r!
      })
      return reply.send(c)
    },
  )

  // Derived for other screens (contacts, funnel): ?contatoIds=a,b,c (max 200).
  app.get<{ Querystring: Record<string, unknown> }>(
    '/v1/tarefas/sem-proximo-passo', { preHandler: exigirTenant },
    async (req, reply) => {
      const parsed = consultaSemProximoPasso.safeParse(req.query)
      if (!parsed.success) return entradaInvalida(reply, parsed.error)
      const ids = [...new Set((parsed.data.contatoIds ?? '').split(',').map((s) => s.trim()).filter(Boolean))]
      if (ids.length === 0) return reply.send({ itens: [] })
      if (ids.length > CONSULTA_MAX) return reply.code(422).send({ erro: 'tarefa.consulta_grande', mensagem: `Máximo de ${CONSULTA_MAX} contatos por consulta.`, campos: ['contatoIds'] })
      if (ids.some((i) => !UUID.test(i))) return reply.code(422).send({ erro: 'tarefa.id_invalido', campos: ['contatoIds'] })
      const { linhas, visiveis } = await req.comTenant(async (tx) => {
        // ⚠️ Escopo (D3): contato fora do escopo some da resposta (como inexistente).
        const escopo = await escopoDaRequisicao(tx, req)
        const visiveis = escopo.tipo === 'tudo' ? ids : (await tx<{ id: string }[]>`
          SELECT c.id FROM contato c
           WHERE c.tenant_id = tenant_atual() AND c.id = ANY(${ids}::uuid[]) AND ${condicaoContato(tx, escopo, 'c')}`).map((l) => l.id)
        const linhas = visiveis.length === 0 ? [] : await tx<{ contato_id: string; futuras: number }[]>`
          SELECT t.contato_id, count(*)::int AS futuras
            FROM tarefa t
           WHERE t.tenant_id = tenant_atual() AND t.estado = 'aberta' AND t.vence_em >= now()
             AND t.contato_id = ANY(${visiveis}::uuid[])
           GROUP BY t.contato_id`
        return { linhas, visiveis: new Set(visiveis) }
      })
      const futuras = new Map(linhas.map((l) => [l.contato_id, l.futuras]))
      // Agenda (C2): só conta com o módulo ligado — desligado, a consulta nem roda.
      const { moduloAgendaAtivo, eventos } = await req.comTenant(async (tx) => {
        const ativo = await moduloAtivo(tx, 'agenda')
        if (!ativo) return { moduloAgendaAtivo: false, eventos: new Map<string, number>() }
        const l = await tx<{ contato_id: string; futuros: number }[]>`
          SELECT e.contato_id, count(*)::int AS futuros
            FROM evento_agenda e
           WHERE e.tenant_id = tenant_atual() AND e.status = 'agendado' AND e.inicio >= now()
             AND e.contato_id = ANY(${ids}::uuid[])
           GROUP BY e.contato_id`
        return { moduloAgendaAtivo: true, eventos: new Map(l.map((x) => [x.contato_id, x.futuros])) }
      })
      return reply.send({
        itens: ids.filter((contatoId) => visiveis.has(contatoId)).map((contatoId) => {
          const tarefasAbertasFuturas = futuras.get(contatoId) ?? 0
          return {
            contatoId, tarefasAbertasFuturas,
            semProximoPasso: semProximoPasso({
              tarefasAbertasFuturas, eventosFuturos: eventos.get(contatoId) ?? 0, moduloAgendaAtivo,
            }),
          }
        }),
      })
    },
  )

  const responsavelExiste = responsavelDoTenantExiste
  const contatoExiste = async (tx: Sql, id: string): Promise<boolean> => {
    const [c] = await tx`SELECT 1 FROM contato WHERE tenant_id = tenant_atual() AND id = ${id}`
    return !!c
  }

  app.post<{ Body: unknown }>(
    '/v1/tarefas', { preHandler: exigirTenant },
    async (req, reply) => {
      const parsed = corpoTarefa.safeParse(req.body)
      if (!parsed.success) return entradaInvalida(reply, parsed.error)
      const v = parsed.data
      const id = randomUUID()
      const falha = await req.comTenant(async (tx): Promise<'contatoId' | 'responsavelId' | null> => {
        const eu = await garantirUsuarioId(tx, req)
        // ⚠️ Escopo (D3): contato fora do escopo responde como inexistente — a lista
        //    devolveria o nome de um cliente alheio.
        if (v.contatoId && !(await contatoExiste(tx, v.contatoId)
          && await contatoNoEscopo(tx, await escopoDaRequisicao(tx, req), v.contatoId))) return 'contatoId'
        if (v.responsavelId && !(await responsavelExiste(tx, v.responsavelId))) return 'responsavelId'
        await tx`INSERT INTO tarefa (tenant_id, id, contato_id, responsavel_id, titulo, descricao, vence_em, criado_por, tipo)
                 VALUES (tenant_atual(), ${id}, ${v.contatoId ?? null}, ${v.responsavelId ?? eu}, ${v.titulo},
                         ${v.descricao?.trim() || null}, ${v.venceEm}, ${eu}, ${v.tipo ?? 'outro'})`
        return null
      })
      if (falha === 'contatoId') return reply.code(422).send({ erro: 'tarefa.contato_invalido', mensagem: 'Contato não encontrado.', campos: ['contatoId'] })
      if (falha === 'responsavelId') return reply.code(422).send({ erro: 'tarefa.responsavel_invalido', mensagem: 'Responsável não encontrado.', campos: ['responsavelId'] })
      return reply.code(201).send({ id })
    },
  )

  // One task per contact, one transaction (all or nothing), audited. Managers only.
  app.post<{ Body: unknown }>(
    '/v1/tarefas/lote', { preHandler: [exigirTenant, exigirPapel('gestor', 'supervisor')] },
    async (req, reply) => {
      const parsed = corpoLote.safeParse(req.body)
      if (!parsed.success) return entradaInvalida(reply, parsed.error)
      const { contatoIds, ...v } = parsed.data
      const ids = [...new Set(contatoIds)]
      const tipo = v.tipo ?? 'outro'
      const res = await req.comTenant(async (tx) => {
        const escopo = await escopoDaRequisicao(tx, req)
        const eu = await garantirUsuarioId(tx, req)
        if (v.responsavelId && !(await responsavelExiste(tx, v.responsavelId))) return null
        const criadas = await criarTarefasEmLote(tx, escopo, eu, ids, { ...v, tipo })
        await auditar(tx, {
          atorId: eu, acao: 'tarefa.lote', entidade: 'tarefa',
          dados: { solicitados: ids.length, criadas: criadas.length, tipo, titulo: v.titulo },
        })
        return { criadas: criadas.length, ignorados: ids.length - criadas.length }
      })
      if (!res) return reply.code(422).send({ erro: 'tarefa.responsavel_invalido', mensagem: 'Responsável não encontrado.', campos: ['responsavelId'] })
      return reply.code(201).send(res)
    },
  )

  /**
   * Closes an open task (done or cancelled). Allowed for the assignee, the creator, or
   * manager/supervisor/admin; audited. Shared by both routes.
   */
  async function encerrar(
    req: FastifyRequest, reply: FastifyReply, id: string,
    novo: 'concluida' | 'cancelada', resultado: string | null,
  ): Promise<FastifyReply> {
    const r = await req.comTenant(async (tx): Promise<'nao_encontrada' | 'nao_aberta' | 'proibido' | 'ok'> => {
      // ⚠️ Escopo (D3): tarefa fora do escopo = 404, antes de qualquer outra resposta.
      if (!(await tarefaNoEscopo(tx, await escopoDaRequisicao(tx, req), id))) return 'nao_encontrada'
      const eu = await garantirUsuarioId(tx, req)
      const [t] = await tx<{ estado: string; responsavel_id: string | null; criado_por: string | null }[]>`
        SELECT estado, responsavel_id, criado_por FROM tarefa
         WHERE tenant_id = tenant_atual() AND id = ${id} FOR UPDATE`
      if (!t) return 'nao_encontrada'
      if (t.estado !== 'aberta') return 'nao_aberta'
      if (t.responsavel_id !== eu && t.criado_por !== eu) {
        const acesso = await papeisDoUsuario(tx, { sub: subDoUsuario(req), atorStaff: req.atorStaff })
        if (!atendePapel(acesso, ['gestor', 'supervisor'])) return 'proibido'
      }
      if (novo === 'concluida') {
        await tx`UPDATE tarefa SET estado = 'concluida', concluida_em = now(), resultado = ${resultado}, concluida_por = ${eu}
                  WHERE tenant_id = tenant_atual() AND id = ${id}`
      } else {
        await tx`UPDATE tarefa SET estado = 'cancelada' WHERE tenant_id = tenant_atual() AND id = ${id}`
      }
      await auditar(tx, {
        atorId: eu, acao: novo === 'concluida' ? 'tarefa.concluida' : 'tarefa.cancelada',
        entidade: 'tarefa', entidadeId: id,
      })
      return 'ok'
    })
    if (r === 'nao_encontrada') return reply.code(404).send({ erro: 'tarefa.nao_encontrada' })
    if (r === 'nao_aberta') return reply.code(409).send({ erro: 'tarefa.nao_aberta' })
    if (r === 'proibido') {
      return reply.code(403).send({
        erro: 'acesso.papel_insuficiente', mensagem: 'Só o responsável, quem criou a tarefa ou a gestão pode alterá-la.',
      })
    }
    return reply.send({ ok: true })
  }

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/v1/tarefas/:id/concluir', { preHandler: exigirTenant },
    async (req, reply) => {
      const p = paramId.safeParse(req.params)
      if (!p.success) return reply.code(404).send({ erro: 'tarefa.nao_encontrada' })
      const corpo = corpoConcluir.safeParse(req.body)
      if (!corpo.success) return entradaInvalida(reply, corpo.error)
      return encerrar(req, reply, p.data.id, 'concluida', corpo.data?.resultado?.trim() || null)
    },
  )

  app.post<{ Params: { id: string } }>(
    '/v1/tarefas/:id/cancelar', { preHandler: exigirTenant },
    async (req, reply) => {
      const p = paramId.safeParse(req.params)
      if (!p.success) return reply.code(404).send({ erro: 'tarefa.nao_encontrada' })
      return encerrar(req, reply, p.data.id, 'cancelada', null)
    },
  )
}
