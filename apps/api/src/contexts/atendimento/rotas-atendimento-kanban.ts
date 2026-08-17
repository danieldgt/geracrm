import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Sql } from '../../db/index.js'
import { exigirTenant } from '../../plugins/tenant.js'

/**
 * Kanban de ATENDIMENTOS com etapas configuráveis por empresa (a visão do gestor).
 *
 * ⚠️ A "Fila" é DERIVADA da conversa (entrante sem atendimento aberto), 1ª coluna;
 * as demais são `atendimento_etapa` (por tenant). Mover sincroniza o `estado`
 * coarse pela `tipo` da etapa e emite `atendimento.mudou` — é aqui que o
 * "encerrar" (mover p/ etapa tipo 'encerrado') passa a existir.
 * ⚠️ O card carrega SÓ metadados — NUNCA conteúdo da conversa (ADR-007).
 */
const PAGINA = 50
const DIAS_ENCERRADO = 30 // colunas 'encerrado' mostram só os recentes

const ETAPAS_PADRAO = [
  { ordem: 1, chave: 'em_atendimento', nome: 'Em atendimento', tipo: 'atendimento' },
  { ordem: 2, chave: 'aguardando_cliente', nome: 'Aguardando cliente', tipo: 'atendimento' },
  { ordem: 9, chave: 'resolvido', nome: 'Resolvido', tipo: 'encerrado' },
]

/**
 * Semeia o fluxo padrão se o tenant não tem etapas (tenant novo — não há bootstrap
 * central). Idempotente. Roda dentro de `comTenant` (tenant_atual()).
 */
export async function garantirEtapasAtendimento(tx: Sql): Promise<void> {
  const [existe] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM atendimento_etapa WHERE tenant_id = tenant_atual()`
  if ((existe?.n ?? 0) > 0) return
  for (const e of ETAPAS_PADRAO) {
    await tx`INSERT INTO atendimento_etapa (tenant_id, id, ordem, chave, nome, tipo)
             VALUES (tenant_atual(), ${randomUUID()}, ${e.ordem}, ${e.chave}, ${e.nome}, ${e.tipo})
             ON CONFLICT (tenant_id, chave) DO NOTHING`
  }
}

async function emitirMudou(tx: Sql, conversaId: string): Promise<void> {
  const [conv] = await tx<{ versao: string }[]>`
    UPDATE conversa SET versao = versao + 1 WHERE tenant_id = tenant_atual() AND id = ${conversaId} RETURNING versao`
  await tx`INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id, payload)
           VALUES (tenant_atual(), 'atendimento.mudou', 'conversa', ${conversaId},
                   ${JSON.stringify({ conversaId, versao: Number(conv?.versao ?? 0) })}::text::jsonb)`
}

function slug(nome: string): string {
  return nome.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'etapa'
}

export async function rotasAtendimentoKanban(app: FastifyInstance): Promise<void> {
  /** Etapas (ordenadas) + contagem por coluna + total da fila derivada. */
  app.get('/v1/atendimento-kanban/etapas', { preHandler: exigirTenant }, async (req, reply) => {
    const dados = await req.comTenant(async (tx) => {
      await garantirEtapasAtendimento(tx)
      const [fila] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM conversa cv
         WHERE cv.tenant_id = tenant_atual() AND NOT cv.arquivada AND cv.ultima_direcao = 'entrante'
           AND NOT EXISTS (SELECT 1 FROM atendimento a
                            WHERE a.tenant_id = cv.tenant_id AND a.conversa_id = cv.id AND a.estado <> 'encerrado')`
      const etapas = await tx<{ id: string; chave: string; nome: string; tipo: string; ordem: number; total: number }[]>`
        SELECT e.id, e.chave, e.nome, e.tipo, e.ordem,
               (SELECT count(*) FROM atendimento a
                 WHERE a.tenant_id = e.tenant_id AND a.etapa_id = e.id
                   AND (e.tipo = 'atendimento' OR a.entrou_etapa_em >= now() - (${DIAS_ENCERRADO} || ' days')::interval))::int AS total
          FROM atendimento_etapa e
         WHERE e.tenant_id = tenant_atual() AND e.ativo
         ORDER BY e.ordem`
      return { fila: fila?.n ?? 0, etapas }
    })
    return reply.send({ aguardando: { total: dados.fila }, itens: dados.etapas })
  })

  /** Fila derivada (conversas entrantes sem atendimento aberto). Cursor por (ultima_mensagem_em, id). */
  app.get<{ Querystring: { cursor?: string } }>(
    '/v1/atendimento-kanban/aguardando', { preHandler: exigirTenant },
    async (req, reply) => {
      let curEm: string | null = null, curId: string | null = null
      if (req.query.cursor) {
        const [em, id] = Buffer.from(req.query.cursor, 'base64url').toString('utf8').split('§')
        if (!em || !id) return reply.code(422).send({ erro: 'cursor.invalido' })
        curEm = em; curId = id
      }
      const linhas = await req.comTenant((tx) => tx<{ id: string; nome: string; ultima_mensagem_em: Date | null }[]>`
        SELECT cv.id, ct.nome, cv.ultima_mensagem_em
          FROM conversa cv JOIN contato ct ON ct.tenant_id = cv.tenant_id AND ct.id = cv.contato_id
         WHERE cv.tenant_id = tenant_atual() AND NOT cv.arquivada AND cv.ultima_direcao = 'entrante'
           AND NOT EXISTS (SELECT 1 FROM atendimento a
                            WHERE a.tenant_id = cv.tenant_id AND a.conversa_id = cv.id AND a.estado <> 'encerrado')
           AND ${curEm === null ? tx`true` : tx`(cv.ultima_mensagem_em, cv.id) < (${curEm}::timestamptz, ${curId}::uuid)`}
         ORDER BY cv.ultima_mensagem_em DESC NULLS LAST, cv.id DESC
         LIMIT ${PAGINA + 1}`)
      const temMais = linhas.length > PAGINA
      const pagina = temMais ? linhas.slice(0, PAGINA) : linhas
      const ultimo = pagina[pagina.length - 1]
      const proximoCursor = temMais && ultimo?.ultima_mensagem_em
        ? Buffer.from(`${ultimo.ultima_mensagem_em.toISOString()}§${ultimo.id}`, 'utf8').toString('base64url') : null
      return reply.send({
        itens: pagina.map((l) => ({ conversaId: l.id, contato: l.nome, ultimaMensagemEm: l.ultima_mensagem_em })),
        proximoCursor,
      })
    },
  )

  /** Atendimentos de UMA etapa (coluna), paginados por (entrou_etapa_em, id). */
  app.get<{ Params: { etapaId: string }; Querystring: { cursor?: string } }>(
    '/v1/atendimento-kanban/coluna/:etapaId', { preHandler: exigirTenant },
    async (req, reply) => {
      let curEm: string | null = null, curId: string | null = null
      if (req.query.cursor) {
        const [em, id] = Buffer.from(req.query.cursor, 'base64url').toString('utf8').split('§')
        if (!em || !id) return reply.code(422).send({ erro: 'cursor.invalido' })
        curEm = em; curId = id
      }
      const linhas = await req.comTenant((tx) => tx<{
        id: string; conversa_id: string; nome: string; atendente: string | null
        protocolo: string; entrou_etapa_em: Date | null; versao: string
      }[]>`
        SELECT a.id, a.conversa_id, ct.nome, u.nome AS atendente,
               a.protocolo::text, a.entrou_etapa_em, a.versao::text
          FROM atendimento a
          JOIN atendimento_etapa e ON e.tenant_id = a.tenant_id AND e.id = a.etapa_id
          JOIN conversa cv ON cv.tenant_id = a.tenant_id AND cv.id = a.conversa_id
          JOIN contato ct ON ct.tenant_id = cv.tenant_id AND ct.id = cv.contato_id
          LEFT JOIN usuario u ON u.tenant_id = a.tenant_id AND u.id = a.atendente_id
         WHERE a.tenant_id = tenant_atual() AND a.etapa_id = ${req.params.etapaId}
           AND (e.tipo = 'atendimento' OR a.entrou_etapa_em >= now() - (${DIAS_ENCERRADO} || ' days')::interval)
           AND ${curEm === null ? tx`true` : tx`(a.entrou_etapa_em, a.id) > (${curEm}::timestamptz, ${curId}::uuid)`}
         ORDER BY a.entrou_etapa_em ASC, a.id ASC
         LIMIT ${PAGINA + 1}`)
      const temMais = linhas.length > PAGINA
      const pagina = temMais ? linhas.slice(0, PAGINA) : linhas
      const ultimo = pagina[pagina.length - 1]
      const proximoCursor = temMais && ultimo?.entrou_etapa_em
        ? Buffer.from(`${ultimo.entrou_etapa_em.toISOString()}§${ultimo.id}`, 'utf8').toString('base64url') : null
      return reply.send({
        itens: pagina.map((l) => ({
          atendimentoId: l.id, conversaId: l.conversa_id, contato: l.nome, atendente: l.atendente,
          protocolo: Number(l.protocolo), entrouEtapaEm: l.entrou_etapa_em, versao: Number(l.versao),
        })),
        proximoCursor,
      })
    },
  )

  /** Mover um atendimento de etapa (concorrência otimista + histórico + estado + outbox). */
  app.post<{ Params: { id: string }; Body: { etapaId?: string; versao?: number } }>(
    '/v1/atendimento-kanban/:id/mover', { preHandler: exigirTenant },
    async (req, reply) => {
      const { etapaId, versao } = req.body ?? {}
      if (!etapaId) return reply.code(422).send({ erro: 'etapa.ausente' })
      const r = await req.comTenant(async (tx) => {
        const [a] = await tx<{ conversa_id: string; estado: string; versao: string; etapa_id: string | null }[]>`
          SELECT conversa_id, estado, versao::text, etapa_id FROM atendimento
           WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        if (!a) return { erro: 'nao_encontrado' as const }
        if (versao !== undefined && Number(a.versao) !== versao) return { erro: 'conflito' as const }
        const [etapa] = await tx<{ tipo: string }[]>`
          SELECT tipo FROM atendimento_etapa WHERE tenant_id = tenant_atual() AND id = ${etapaId} AND ativo`
        if (!etapa) return { erro: 'etapa_nao_encontrada' as const }
        const novoEstado = etapa.tipo === 'encerrado' ? 'encerrado' : 'em_atendimento'
        // ⚠️ Reabrir (encerrado → atendimento) só se a conversa não tiver OUTRO aberto (INV-51).
        if (novoEstado === 'em_atendimento' && a.estado === 'encerrado') {
          const [outro] = await tx<{ n: number }[]>`
            SELECT count(*)::int AS n FROM atendimento
             WHERE tenant_id = tenant_atual() AND conversa_id = ${a.conversa_id}
               AND id <> ${req.params.id} AND estado <> 'encerrado'`
          if ((outro?.n ?? 0) > 0) return { erro: 'ja_tem_aberto' as const }
        }
        // Fecha a estadia anterior e abre a nova (aging).
        await tx`UPDATE atendimento_etapa_historico SET saiu_em = now()
                  WHERE tenant_id = tenant_atual() AND atendimento_id = ${req.params.id} AND saiu_em IS NULL`
        await tx`UPDATE atendimento SET
                   etapa_id = ${etapaId}, entrou_etapa_em = now(), versao = versao + 1,
                   estado = ${novoEstado},
                   encerrado_em = ${novoEstado === 'encerrado' ? tx`coalesce(encerrado_em, now())` : tx`NULL`}
                 WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        await tx`INSERT INTO atendimento_etapa_historico (tenant_id, id, atendimento_id, etapa_id, entrou_em)
                 VALUES (tenant_atual(), ${randomUUID()}, ${req.params.id}, ${etapaId}, now())`
        await emitirMudou(tx, a.conversa_id)
        return { ok: true as const }
      })
      if ('erro' in r) {
        if (r.erro === 'nao_encontrado') return reply.code(404).send({ erro: 'atendimento.nao_encontrado' })
        if (r.erro === 'etapa_nao_encontrada') return reply.code(404).send({ erro: 'etapa.nao_encontrada' })
        if (r.erro === 'conflito') return reply.code(409).send({ erro: 'atendimento.conflito', mensagem: 'Alguém moveu antes — recarregue.' })
        return reply.code(409).send({ erro: 'atendimento.ja_tem_aberto', mensagem: 'A conversa já tem um atendimento aberto.' })
      }
      return reply.send({ ok: true })
    },
  )

  // ───────── Config das etapas (a empresa monta o fluxo) ─────────
  app.get('/v1/atendimento-kanban/config/etapas', { preHandler: exigirTenant }, async (req, reply) => {
    const itens = await req.comTenant(async (tx) => {
      await garantirEtapasAtendimento(tx)
      return tx<{ id: string; chave: string; nome: string; tipo: string; ordem: number; ativo: boolean; total: number }[]>`
        SELECT e.id, e.chave, e.nome, e.tipo, e.ordem, e.ativo,
               (SELECT count(*) FROM atendimento a WHERE a.tenant_id = e.tenant_id AND a.etapa_id = e.id)::int AS total
          FROM atendimento_etapa e WHERE e.tenant_id = tenant_atual() ORDER BY e.ordem`
    })
    return reply.send({ itens })
  })

  app.post<{ Body: { nome?: string; tipo?: string } }>(
    '/v1/atendimento-kanban/config/etapas', { preHandler: exigirTenant },
    async (req, reply) => {
      const nome = req.body?.nome?.trim()
      const tipo = req.body?.tipo === 'encerrado' ? 'encerrado' : 'atendimento'
      if (!nome) return reply.code(422).send({ erro: 'etapa.nome_vazio', mensagem: 'Dê um nome à etapa.' })
      const id = await req.comTenant(async (tx) => {
        const [ordem] = await tx<{ prox: number }[]>`SELECT coalesce(max(ordem), 0) + 1 AS prox FROM atendimento_etapa WHERE tenant_id = tenant_atual()`
        const chave = `${slug(nome)}_${randomUUID().slice(0, 4)}`
        const nid = randomUUID()
        await tx`INSERT INTO atendimento_etapa (tenant_id, id, ordem, chave, nome, tipo)
                 VALUES (tenant_atual(), ${nid}, ${ordem?.prox ?? 1}, ${chave}, ${nome}, ${tipo})`
        return nid
      })
      return reply.code(201).send({ id })
    },
  )

  app.patch<{ Params: { id: string }; Body: { nome?: string; ordem?: number; ativo?: boolean; tipo?: string } }>(
    '/v1/atendimento-kanban/config/etapas/:id', { preHandler: exigirTenant },
    async (req, reply) => {
      const b = req.body ?? {}
      const tipo = b.tipo === undefined ? null : (b.tipo === 'encerrado' ? 'encerrado' : 'atendimento')
      const [row] = await req.comTenant((tx) => tx<{ id: string }[]>`
        UPDATE atendimento_etapa SET
          nome  = coalesce(${b.nome?.trim() ?? null}, nome),
          ordem = coalesce(${b.ordem ?? null}, ordem),
          ativo = coalesce(${b.ativo ?? null}, ativo),
          tipo  = coalesce(${tipo}, tipo)
         WHERE tenant_id = tenant_atual() AND id = ${req.params.id}
        RETURNING id`)
      if (!row) return reply.code(404).send({ erro: 'etapa.nao_encontrada' })
      return reply.send({ ok: true })
    },
  )

  /** ⚠️ Se há atendimento na etapa, DESATIVA (não apaga) — guarda da skill funil-de-vendas §9. */
  app.delete<{ Params: { id: string } }>(
    '/v1/atendimento-kanban/config/etapas/:id', { preHandler: exigirTenant },
    async (req, reply) => {
      const r = await req.comTenant(async (tx) => {
        const [uso] = await tx<{ n: number }[]>`
          SELECT count(*)::int AS n FROM atendimento WHERE tenant_id = tenant_atual() AND etapa_id = ${req.params.id}`
        if ((uso?.n ?? 0) > 0) {
          const [row] = await tx<{ id: string }[]>`
            UPDATE atendimento_etapa SET ativo = false WHERE tenant_id = tenant_atual() AND id = ${req.params.id} RETURNING id`
          return row ? { estado: 'desativada' as const } : { estado: 'nao_encontrada' as const }
        }
        const [row] = await tx<{ id: string }[]>`
          DELETE FROM atendimento_etapa WHERE tenant_id = tenant_atual() AND id = ${req.params.id} RETURNING id`
        return row ? { estado: 'removida' as const } : { estado: 'nao_encontrada' as const }
      })
      if (r.estado === 'nao_encontrada') return reply.code(404).send({ erro: 'etapa.nao_encontrada' })
      return reply.send({ ok: true, estado: r.estado })
    },
  )
}
