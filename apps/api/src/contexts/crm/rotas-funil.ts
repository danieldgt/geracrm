import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { exigirTenant } from '../../plugins/tenant.js'
import { garantirUsuarioId } from '../atendimento/rotas-fila.js'

const PAGINA = 50 // cards por página de coluna (kanban paginado por coluna, ADR)

/**
 * Kanban do funil de relacionamento (Onda 2).
 *
 * ⚠️ Paginação POR COLUNA por cursor `(posicao, id)` — nunca virtual scroll (o
 * CDK não junta drag-drop + virtual scroll) nem lista ilimitada. A coluna tem
 * 11 mil cards; carrega 50 e "carregar mais".
 *
 * ⚠️ Perda exige motivo do catálogo (garantido no banco). Mover usa concorrência
 * OTIMISTA (`versao`): duas vendedoras arrastando o mesmo card — a segunda leva
 * 409, não sobrescreve.
 */
export async function rotasFunil(app: FastifyInstance): Promise<void> {
  /** Estágios (ordenados) + contagem de cards por estágio. */
  app.get('/v1/funil/etapas', { preHandler: exigirTenant }, async (req, reply) => {
    const linhas = await req.comTenant((tx) => tx<{
      id: string; chave: string; nome: string; tipo: string; criterio: string | null; total: number
    }[]>`
      SELECT e.id, e.chave, e.nome, e.tipo, e.criterio,
             (SELECT count(*) FROM oportunidade o WHERE o.tenant_id = e.tenant_id AND o.etapa_id = e.id)::int AS total
        FROM funil_etapa e
       WHERE e.tenant_id = tenant_atual() AND e.ativo
       ORDER BY e.ordem`)
    return reply.send({ itens: linhas.map((l) => ({
      id: l.id, chave: l.chave, nome: l.nome, tipo: l.tipo, criterio: l.criterio, total: l.total,
    })) })
  })

  /** Motivos de perda (catálogo fechado). */
  app.get('/v1/funil/motivos', { preHandler: exigirTenant }, async (req, reply) => {
    const linhas = await req.comTenant((tx) => tx<{ codigo: string; nome: string }[]>`
      SELECT codigo, nome FROM motivo_perda WHERE tenant_id = tenant_atual() AND ativo ORDER BY nome`)
    return reply.send({ itens: linhas })
  })

  /** Cards de UMA coluna, paginados por cursor (posicao, id). */
  app.get<{ Params: { etapaId: string }; Querystring: { cursor?: string } }>(
    '/v1/funil/coluna/:etapaId',
    { preHandler: exigirTenant },
    async (req, reply) => {
      let curPos: string | null = null
      let curId: string | null = null
      if (req.query.cursor) {
        const [p, id] = Buffer.from(req.query.cursor, 'base64url').toString('utf8').split('§')
        if (!p || !id) return reply.code(422).send({ erro: 'cursor.invalido' })
        curPos = p; curId = id
      }
      const linhas = await req.comTenant((tx) => tx<{
        id: string; contato_id: string; nome: string; titulo: string | null
        valor_estimado_centavos: string | null; responsavel: string | null
        posicao: number; entrou_etapa_em: Date; versao: string
      }[]>`
        SELECT o.id, o.contato_id, c.nome, o.titulo, o.valor_estimado_centavos::text,
               u.nome AS responsavel, o.posicao, o.entrou_etapa_em, o.versao::text
          FROM oportunidade o
          JOIN contato c ON c.tenant_id = o.tenant_id AND c.id = o.contato_id
          LEFT JOIN usuario u ON u.tenant_id = o.tenant_id AND u.id = o.responsavel_id
         WHERE o.tenant_id = tenant_atual() AND o.etapa_id = ${req.params.etapaId}
           AND ${curPos === null ? tx`true` : tx`(o.posicao, o.id) > (${curPos}::double precision, ${curId}::uuid)`}
         ORDER BY o.posicao ASC, o.id ASC
         LIMIT ${PAGINA + 1}`)

      const temMais = linhas.length > PAGINA
      const pagina = temMais ? linhas.slice(0, PAGINA) : linhas
      const ultimo = pagina[pagina.length - 1]
      const proximoCursor = temMais && ultimo
        ? Buffer.from(`${ultimo.posicao}§${ultimo.id}`).toString('base64url') : null

      return reply.send({
        itens: pagina.map((l) => ({
          id: l.id, contatoId: l.contato_id, nome: l.titulo || l.nome,
          valorCentavos: l.valor_estimado_centavos ? Number(l.valor_estimado_centavos) : null,
          responsavel: l.responsavel, entrouEtapaEm: l.entrou_etapa_em,
          posicao: l.posicao, versao: Number(l.versao),
        })),
        proximoCursor,
      })
    },
  )

  /** Cria uma oportunidade no 1º estágio (lead). Uma aberta por contato (atômico). */
  app.post<{ Body: { contatoId?: string; titulo?: string; valorCentavos?: number } }>(
    '/v1/funil/oportunidades',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const contatoId = req.body?.contatoId
      if (!contatoId) return reply.code(422).send({ erro: 'contato.obrigatorio', mensagem: 'Informe o contato.' })

      const r = await req.comTenant(async (tx) => {
        const [etapa] = await tx<{ id: string }[]>`
          SELECT id FROM funil_etapa WHERE tenant_id = tenant_atual() AND chave = 'lead'`
        if (!etapa) return { erro: 'sem_etapa' as const }
        const [c] = await tx`SELECT 1 FROM contato WHERE tenant_id = tenant_atual() AND id = ${contatoId}`
        if (!c) return { erro: 'contato_nao_encontrado' as const }

        const id = randomUUID()
        // ⚠️ Vencedor atômico: uma aberta por contato (índice parcial).
        const [criada] = await tx<{ id: string }[]>`
          INSERT INTO oportunidade (tenant_id, id, contato_id, etapa_id, titulo, valor_estimado_centavos, posicao)
          VALUES (tenant_atual(), ${id}, ${contatoId}, ${etapa.id}, ${req.body?.titulo ?? null},
                  ${req.body?.valorCentavos ?? null}, extract(epoch from now()))
          ON CONFLICT (tenant_id, contato_id) WHERE estado = 'aberta' DO NOTHING
          RETURNING id`
        if (!criada) return { erro: 'ja_tem_aberta' as const }
        await tx`INSERT INTO oportunidade_etapa_historico (tenant_id, id, oportunidade_id, etapa_id, ator_id)
                 VALUES (tenant_atual(), ${randomUUID()}, ${id}, ${etapa.id}, ${await garantirUsuarioId(tx, req)})`
        return { id }
      })
      if ('erro' in r) {
        const cod = { sem_etapa: 500, contato_nao_encontrado: 404, ja_tem_aberta: 409 }[r.erro]
        return reply.code(cod).send({ erro: `oportunidade.${r.erro}` })
      }
      return reply.code(201).send({ id: r.id })
    },
  )

  /**
   * Move um card para outro estágio. Concorrência otimista por `versao`. Perda
   * exige motivo. Atualiza histórico (fecha o anterior, abre o novo).
   */
  app.post<{ Params: { id: string }; Body: { etapaId?: string; posicao?: number; versao?: number; motivo?: string } }>(
    '/v1/funil/oportunidades/:id/mover',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const { etapaId, posicao, versao, motivo } = req.body ?? {}
      if (!etapaId || typeof versao !== 'number') {
        return reply.code(422).send({ erro: 'move.invalido', mensagem: 'Estágio e versão são obrigatórios.' })
      }

      const r = await req.comTenant(async (tx) => {
        const [etapa] = await tx<{ tipo: string }[]>`
          SELECT tipo FROM funil_etapa WHERE tenant_id = tenant_atual() AND id = ${etapaId}`
        if (!etapa) return { erro: 'etapa_nao_encontrada' as const }
        // ⚠️ Perda sem motivo é barrada aqui (e no banco pelo CHECK).
        if (etapa.tipo === 'perdido' && !motivo) return { erro: 'motivo_obrigatorio' as const }

        const estado = etapa.tipo === 'perdido' ? 'perdida' : etapa.tipo === 'ganho' ? 'ganha' : 'aberta'
        const fecha = estado !== 'aberta'
        const [mov] = await tx<{ id: string }[]>`
          UPDATE oportunidade
             SET etapa_id = ${etapaId}, posicao = ${posicao ?? 0}, entrou_etapa_em = now(),
                 estado = ${estado}, motivo_perda_codigo = ${etapa.tipo === 'perdido' ? motivo! : null},
                 fechada_em = ${fecha ? tx`now()` : null}, versao = versao + 1
           WHERE tenant_id = tenant_atual() AND id = ${req.params.id} AND versao = ${versao}
           RETURNING id`
        if (!mov) {
          const [existe] = await tx`SELECT 1 FROM oportunidade WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
          return { erro: existe ? ('conflito' as const) : ('nao_encontrada' as const) }
        }
        // Histórico: fecha a etapa anterior, abre a nova.
        await tx`UPDATE oportunidade_etapa_historico SET saiu_em = now()
                  WHERE tenant_id = tenant_atual() AND oportunidade_id = ${req.params.id} AND saiu_em IS NULL`
        await tx`INSERT INTO oportunidade_etapa_historico (tenant_id, id, oportunidade_id, etapa_id, ator_id)
                 VALUES (tenant_atual(), ${randomUUID()}, ${req.params.id}, ${etapaId}, ${await garantirUsuarioId(tx, req)})`
        return { ok: true as const }
      })

      if ('erro' in r) {
        const cod = { etapa_nao_encontrada: 404, motivo_obrigatorio: 422, conflito: 409, nao_encontrada: 404 }[r.erro]
        return reply.code(cod).send({ erro: `move.${r.erro}`, mensagem:
          r.erro === 'conflito' ? 'Alguém moveu este card antes de você. Recarregue.' :
          r.erro === 'motivo_obrigatorio' ? 'Escolha o motivo da perda.' : 'Não foi possível mover.' })
      }
      return reply.send({ ok: true })
    },
  )
}
