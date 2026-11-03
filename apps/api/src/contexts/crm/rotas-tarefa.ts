import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { ehTipoTarefa, semProximoPasso, type TipoTarefa } from '@geracrm/shared'
import type { Sql } from '../../db/index.js'
import { exigirTenant } from '../../plugins/tenant.js'
import { garantirUsuarioId } from '../atendimento/rotas-fila.js'
import { auditar } from '../plataforma/auditoria.js'
import { fusoSeguro } from '../plataforma/fuso.js'
import { condicaoContato, condicaoTarefa, contatoNoEscopo, escopoDaRequisicao, type Escopo } from '../plataforma/escopo.js'

const PAGINA = 30
const LOTE_MAX = 500
const CONSULTA_MAX = 200
const RESULTADO_MAX = 2000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DIA = /^\d{4}-\d{2}-\d{2}$/

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
 * segue com o 409 de sempre para inexistente/fechada). Fora do escopo = 404.
 */
async function tarefaNoEscopo(tx: Sql, escopo: Escopo, id: string): Promise<boolean> {
  if (escopo.tipo === 'tudo') return true
  if (!UUID.test(id)) return false
  const [l] = await tx`SELECT 1 FROM tarefa t
                        WHERE t.tenant_id = tenant_atual() AND t.id = ${id} AND ${condicaoTarefa(tx, escopo, 't')}`
  return Boolean(l)
}

/**
 * Tarefas de follow-up. ⚠️ "Situação" é derivada, no fuso do tenant:
 *   • abertas    = estado 'aberta'
 *   • atrasadas  = 'aberta' E vence_em < now()   (alias legado: 'vencidas')
 *   • hoje       = 'aberta' E vence_em dentro do dia local de hoje
 *   • semana     = 'aberta' E vence_em dentro da semana local (segunda a domingo)
 *   • concluidas
 * Ordena por vencimento (mais urgente primeiro). Cursor por (vence_em, id).
 *
 * `responsavel_id` NULL = de ninguém (aparece para todos); por padrão a API grava quem criou.
 */
export async function rotasTarefa(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: {
    situacao?: string; contatoId?: string; tipo?: string; responsavelId?: string; q?: string
    de?: string; ate?: string; cursor?: string
  } }>(
    '/v1/tarefas', { preHandler: exigirTenant },
    async (req, reply) => {
      let curEm: string | null = null, curId: string | null = null
      if (req.query.cursor) {
        const [em, id] = Buffer.from(req.query.cursor, 'base64url').toString('utf8').split('§')
        if (!em || !id) return reply.code(422).send({ erro: 'cursor.invalido' })
        curEm = em; curId = id
      }
      const { situacao, contatoId, tipo, responsavelId, de, ate } = req.query
      const q = req.query.q?.trim() || null
      if (tipo && !ehTipoTarefa(tipo)) return reply.code(422).send({ erro: 'tarefa.tipo_invalido' })
      if ((contatoId && !UUID.test(contatoId)) || (responsavelId && !UUID.test(responsavelId))) {
        return reply.code(422).send({ erro: 'tarefa.id_invalido' })
      }
      if ((de && !DIA.test(de)) || (ate && !DIA.test(ate))) return reply.code(422).send({ erro: 'tarefa.periodo_invalido' })

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
          id: string; titulo: string; descricao: string | null; vence_em: Date; estado: string; tipo: string
          resultado: string | null; concluida_em: Date | null; contato_id: string | null; contato: string | null
          responsavel_id: string | null; responsavel: string | null
        }[]>`
          SELECT t.id, t.titulo, t.descricao, t.vence_em, t.estado, t.tipo, t.resultado, t.concluida_em, t.contato_id,
                 c.nome AS contato, t.responsavel_id, u.nome AS responsavel
            FROM tarefa t
            LEFT JOIN contato c ON c.tenant_id = t.tenant_id AND c.id = t.contato_id
            LEFT JOIN usuario u ON u.tenant_id = t.tenant_id AND u.id = t.responsavel_id
           WHERE t.tenant_id = tenant_atual() AND ${filtroSituacao}
             AND ${contatoId ? tx`t.contato_id = ${contatoId}` : tx`true`}
             AND ${tipo ? tx`t.tipo = ${tipo}` : tx`true`}
             AND ${responsavelId ? tx`t.responsavel_id = ${responsavelId}` : tx`true`}
             AND ${condicaoTarefa(tx, escopo, 't')}
             AND ${q ? tx`(t.titulo ILIKE ${'%' + escaparLike(q) + '%'} OR c.nome ILIKE ${'%' + escaparLike(q) + '%'})` : tx`true`}
             AND ${de ? tx`t.vence_em >= (${de}::date::timestamp AT TIME ZONE ${lim.fuso}::text)` : tx`true`}
             AND ${ate ? tx`t.vence_em < ((${ate}::date + 1)::timestamp AT TIME ZONE ${lim.fuso}::text)` : tx`true`}
             AND ${curEm === null ? tx`true` : tx`(t.vence_em, t.id) > (${curEm}::timestamptz, ${curId}::uuid)`}
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
          ? Buffer.from(`${ultimo.vence_em.toISOString()}§${ultimo.id}`).toString('base64url') : null,
      })
    },
  )

  // Cartões da tela: contagem das ABERTAS, no fuso do tenant.
  app.get<{ Querystring: { responsavelId?: string } }>(
    '/v1/tarefas/contadores', { preHandler: exigirTenant },
    async (req, reply) => {
      const { responsavelId } = req.query
      if (responsavelId && !UUID.test(responsavelId)) return reply.code(422).send({ erro: 'tarefa.id_invalido' })
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
             AND ${responsavelId ? tx`t.responsavel_id = ${responsavelId}` : tx`true`}
             AND ${condicaoTarefa(tx, escopo, 't')}`
        return r!
      })
      return reply.send(c)
    },
  )

  // Derivado para outras telas (contatos, funil): ?contatoIds=a,b,c (máx. 200).
  app.get<{ Querystring: { contatoIds?: string } }>(
    '/v1/tarefas/sem-proximo-passo', { preHandler: exigirTenant },
    async (req, reply) => {
      const ids = [...new Set((req.query.contatoIds ?? '').split(',').map((s) => s.trim()).filter(Boolean))]
      if (ids.length === 0) return reply.send({ itens: [] })
      if (ids.length > CONSULTA_MAX) return reply.code(422).send({ erro: 'tarefa.consulta_grande', mensagem: `Máximo de ${CONSULTA_MAX} contatos por consulta.` })
      if (ids.some((i) => !UUID.test(i))) return reply.code(422).send({ erro: 'tarefa.id_invalido' })
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
      return reply.send({
        itens: ids.filter((contatoId) => visiveis.has(contatoId)).map((contatoId) => {
          const tarefasAbertasFuturas = futuras.get(contatoId) ?? 0
          return {
            contatoId, tarefasAbertasFuturas,
            // TODO(C2): contar eventos futuros da agenda e ler o módulo Agenda do tenant quando a raia C2 existir.
            semProximoPasso: semProximoPasso({ tarefasAbertasFuturas, eventosFuturos: 0, moduloAgendaAtivo: false }),
          }
        }),
      })
    },
  )

  interface CorpoTarefa {
    contatoId?: string; titulo?: string; descricao?: string; venceEm?: string; tipo?: string; responsavelId?: string
  }
  /** Valida os campos comuns ao POST simples e ao lote; devolve o erro 422 ou os valores limpos. */
  const validar = (b: CorpoTarefa | undefined) => {
    const titulo = b?.titulo?.trim()
    if (!titulo) return { erro: { erro: 'tarefa.titulo_obrigatorio', mensagem: 'Dê um título.' } }
    if (!b?.venceEm || Number.isNaN(Date.parse(b.venceEm))) return { erro: { erro: 'tarefa.vencimento_invalido', mensagem: 'Informe o vencimento.' } }
    if (b.tipo !== undefined && !ehTipoTarefa(b.tipo)) return { erro: { erro: 'tarefa.tipo_invalido', mensagem: 'Tipo de tarefa inválido.' } }
    if (b.responsavelId && !UUID.test(b.responsavelId)) return { erro: { erro: 'tarefa.responsavel_invalido', mensagem: 'Responsável inválido.' } }
    return {
      v: {
        titulo, venceEm: b.venceEm, tipo: (b.tipo ?? 'outro') as TipoTarefa,
        descricao: b.descricao?.trim() || null, responsavelId: b.responsavelId ?? null,
      },
    }
  }
  const responsavelExiste = async (tx: Sql, id: string): Promise<boolean> => {
    const [u] = await tx`SELECT 1 FROM usuario WHERE tenant_id = tenant_atual() AND id = ${id}`
    return !!u
  }

  app.post<{ Body: CorpoTarefa }>(
    '/v1/tarefas', { preHandler: exigirTenant },
    async (req, reply) => {
      const r = validar(req.body)
      if (!r.v) return reply.code(422).send(r.erro)
      const v = r.v
      const id = randomUUID()
      const contatoId = req.body?.contatoId
      const ok = await req.comTenant(async (tx) => {
        // ⚠️ Escopo (D3): tarefa só sobre cliente que a pessoa enxerga — a lista
        //    devolveria o nome de um cliente alheio. Fora = 404.
        if (contatoId && !(await contatoNoEscopo(tx, await escopoDaRequisicao(tx, req), contatoId))) return 'fora' as const
        const eu = await garantirUsuarioId(tx, req)
        if (v.responsavelId && !(await responsavelExiste(tx, v.responsavelId))) return false
        await tx`INSERT INTO tarefa (tenant_id, id, contato_id, responsavel_id, titulo, descricao, vence_em, criado_por, tipo)
                 VALUES (tenant_atual(), ${id}, ${req.body?.contatoId ?? null}, ${v.responsavelId ?? eu}, ${v.titulo},
                         ${v.descricao}, ${v.venceEm}, ${eu}, ${v.tipo})`
        return true
      })
      if (ok === 'fora') return reply.code(404).send({ erro: 'contato.nao_encontrado' })
      if (!ok) return reply.code(422).send({ erro: 'tarefa.responsavel_invalido', mensagem: 'Responsável não encontrado.' })
      return reply.code(201).send({ id })
    },
  )

  // Uma tarefa por contato, numa transação só (tudo ou nada), auditada.
  app.post<{ Body: CorpoTarefa & { contatoIds?: string[] } }>(
    '/v1/tarefas/lote', { preHandler: exigirTenant },
    async (req, reply) => {
      const ids = [...new Set(req.body?.contatoIds ?? [])]
      if (ids.length === 0) return reply.code(422).send({ erro: 'tarefa.lote_vazio', mensagem: 'Selecione ao menos um contato.' })
      if (ids.length > LOTE_MAX) return reply.code(422).send({ erro: 'tarefa.lote_grande', mensagem: `Máximo de ${LOTE_MAX} contatos por lote.` })
      if (ids.some((i) => typeof i !== 'string' || !UUID.test(i))) return reply.code(422).send({ erro: 'tarefa.id_invalido' })
      const r = validar(req.body)
      if (!r.v) return reply.code(422).send(r.erro)
      const v = r.v
      const res = await req.comTenant(async (tx) => {
        const escopo = await escopoDaRequisicao(tx, req)
        const eu = await garantirUsuarioId(tx, req)
        if (v.responsavelId && !(await responsavelExiste(tx, v.responsavelId))) return null
        // Só contatos do tenant (RLS + filtro) E do escopo do usuário (D3): id
        // desconhecido ou fora do escopo é ignorado e contado em `ignorados`.
        const criadas = await tx<{ id: string }[]>`
          INSERT INTO tarefa (tenant_id, id, contato_id, responsavel_id, titulo, descricao, vence_em, criado_por, tipo)
          SELECT tenant_atual(), gen_random_uuid(), c.id, ${v.responsavelId ?? eu}, ${v.titulo}, ${v.descricao},
                 ${v.venceEm}, ${eu}, ${v.tipo}
            FROM contato c
           WHERE c.tenant_id = tenant_atual() AND c.id = ANY(${ids}::uuid[])
             AND ${condicaoContato(tx, escopo, 'c')}
          RETURNING id`
        await auditar(tx, {
          atorId: eu, acao: 'tarefa.lote', entidade: 'tarefa',
          dados: { solicitados: ids.length, criadas: criadas.length, tipo: v.tipo, titulo: v.titulo },
        })
        return { criadas: criadas.length, ignorados: ids.length - criadas.length }
      })
      if (!res) return reply.code(422).send({ erro: 'tarefa.responsavel_invalido', mensagem: 'Responsável não encontrado.' })
      return reply.code(201).send(res)
    },
  )

  app.post<{ Params: { id: string }; Body: { resultado?: string } | undefined }>(
    '/v1/tarefas/:id/concluir', { preHandler: exigirTenant },
    async (req, reply) => {
      const resultado = req.body?.resultado?.trim() || null
      if (resultado && resultado.length > RESULTADO_MAX) {
        return reply.code(422).send({ erro: 'tarefa.resultado_grande', mensagem: `Máximo de ${RESULTADO_MAX} caracteres.` })
      }
      const r = await req.comTenant(async (tx) => {
        if (!(await tarefaNoEscopo(tx, await escopoDaRequisicao(tx, req), req.params.id))) return 'fora' as const
        const eu = await garantirUsuarioId(tx, req)
        const [x] = await tx`
          UPDATE tarefa SET estado = 'concluida', concluida_em = now(), resultado = ${resultado}, concluida_por = ${eu}
           WHERE tenant_id = tenant_atual() AND id = ${req.params.id} AND estado = 'aberta' RETURNING id`
        return x ? 'ok' as const : 'nao_aberta' as const
      })
      if (r === 'fora') return reply.code(404).send({ erro: 'tarefa.nao_encontrada' })
      if (r === 'nao_aberta') return reply.code(409).send({ erro: 'tarefa.nao_aberta' })
      return reply.send({ ok: true })
    },
  )

  app.post<{ Params: { id: string } }>(
    '/v1/tarefas/:id/cancelar', { preHandler: exigirTenant },
    async (req, reply) => {
      const r = await req.comTenant(async (tx) => {
        if (!(await tarefaNoEscopo(tx, await escopoDaRequisicao(tx, req), req.params.id))) return 'fora' as const
        const [x] = await tx`
          UPDATE tarefa SET estado = 'cancelada'
           WHERE tenant_id = tenant_atual() AND id = ${req.params.id} AND estado = 'aberta' RETURNING id`
        return x ? 'ok' as const : 'nao_aberta' as const
      })
      if (r === 'fora') return reply.code(404).send({ erro: 'tarefa.nao_encontrada' })
      if (r === 'nao_aberta') return reply.code(409).send({ erro: 'tarefa.nao_aberta' })
      return reply.send({ ok: true })
    },
  )
}
