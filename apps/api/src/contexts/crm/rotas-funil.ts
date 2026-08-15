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

  /**
   * Métricas do funil + recompra (skill funil-de-vendas §"Métricas que valem").
   * Tudo derivado do que já existe: `oportunidade_etapa_historico` (tempo em
   * estágio + conversão A→B), `oportunidade`/`motivo_perda` (perda) e `venda`
   * (recompra + tempo até o 2º pedido). Leitura agregada, sob RLS.
   */
  app.get('/v1/funil/metricas', { preHandler: exigirTenant }, async (req, reply) => {
    const dados = await req.comTenant(async (tx) => {
      // Por estágio: quantos ENTRARAM (histórico) e tempo médio de permanência
      // (só estadias concluídas — saiu_em preenchido — para não inflar com o now()).
      const etapas = await tx<{
        chave: string; nome: string; ordem: number; tipo: string
        entraram: number; tempo_medio_dias: number | null
      }[]>`
        SELECT e.chave, e.nome, e.ordem, e.tipo,
               count(DISTINCT h.oportunidade_id)::int AS entraram,
               round((avg(EXTRACT(EPOCH FROM (h.saiu_em - h.entrou_em)) / 86400.0)
                      FILTER (WHERE h.saiu_em IS NOT NULL))::numeric, 1) AS tempo_medio_dias
          FROM funil_etapa e
          LEFT JOIN oportunidade_etapa_historico h
            ON h.tenant_id = e.tenant_id AND h.etapa_id = e.id
         WHERE e.tenant_id = tenant_atual() AND e.ativo
         GROUP BY e.chave, e.nome, e.ordem, e.tipo
         ORDER BY e.ordem`

      // Recompra: dos clientes com ao menos 1 venda, quantos compraram 2+.
      const [recompra] = await tx<{ com_compra: number; recompraram: number }[]>`
        SELECT count(*) FILTER (WHERE qtd_vendas >= 1)::int AS com_compra,
               count(*) FILTER (WHERE qtd_vendas >= 2)::int AS recompraram
          FROM metricas_contato WHERE tenant_id = tenant_atual()`

      // Tempo até o 2º pedido: (data da 2ª venda − 1ª), média E mediana (a skill
      // pede a mediana ao lado — um outlier gigante distorce a média).
      const [segundo] = await tx<{ base: number; media_dias: number | null; mediana_dias: number | null }[]>`
        WITH ord AS (
          SELECT contato_id, ocorrida_em,
                 row_number() OVER (PARTITION BY contato_id ORDER BY ocorrida_em) AS rn
            FROM venda
           WHERE tenant_id = tenant_atual() AND contato_id IS NOT NULL AND cancelada_em IS NULL
        ),
        ps AS (
          SELECT contato_id,
                 min(ocorrida_em) FILTER (WHERE rn = 1) AS v1,
                 min(ocorrida_em) FILTER (WHERE rn = 2) AS v2
            FROM ord WHERE rn <= 2 GROUP BY contato_id
        ),
        dif AS (SELECT (v2::date - v1::date) AS dias FROM ps WHERE v2 IS NOT NULL)
        SELECT count(*)::int AS base,
               round(avg(dias)::numeric, 1) AS media_dias,
               round((percentile_cont(0.5) WITHIN GROUP (ORDER BY dias))::numeric, 1) AS mediana_dias
          FROM dif`

      // Perda/churn do funil: fechadas × perdidas + top motivos.
      const [perda] = await tx<{ fechadas: number; perdidas: number }[]>`
        SELECT count(*) FILTER (WHERE estado IN ('ganha','perdida'))::int AS fechadas,
               count(*) FILTER (WHERE estado = 'perdida')::int AS perdidas
          FROM oportunidade WHERE tenant_id = tenant_atual()`
      const motivos = await tx<{ codigo: string; nome: string; qtd: number }[]>`
        SELECT o.motivo_perda_codigo AS codigo, m.nome, count(*)::int AS qtd
          FROM oportunidade o
          JOIN motivo_perda m ON m.tenant_id = o.tenant_id AND m.codigo = o.motivo_perda_codigo
         WHERE o.tenant_id = tenant_atual() AND o.estado = 'perdida'
         GROUP BY o.motivo_perda_codigo, m.nome
         ORDER BY qtd DESC`
      return { etapas, recompra, segundo, perda, motivos }
    })

    // Conversão por estágio (A→B): quantos dos que entraram no estágio avançaram
    // para o próximo, na ordem. É onde o gargalo aparece (skill: meça A→B).
    const etapas = dados.etapas.map((e, i) => {
      const prox = dados.etapas[i + 1]
      const conversao = prox && e.entraram > 0 ? Math.round((prox.entraram / e.entraram) * 1000) / 10 : null
      return {
        chave: e.chave, nome: e.nome, tipo: e.tipo,
        entraram: e.entraram,
        tempoMedioDias: e.tempo_medio_dias !== null ? Number(e.tempo_medio_dias) : null,
        conversaoParaProxima: conversao, // % ; null no último estágio ou sem base
      }
    })
    const r = dados.recompra ?? { com_compra: 0, recompraram: 0 }
    const p = dados.perda ?? { fechadas: 0, perdidas: 0 }
    return reply.send({
      etapas,
      recompra: {
        comCompra: r.com_compra, recompraram: r.recompraram,
        taxa: r.com_compra > 0 ? Math.round((r.recompraram / r.com_compra) * 1000) / 10 : null,
      },
      tempoSegundoPedido: {
        base: dados.segundo?.base ?? 0,
        mediaDias: dados.segundo?.media_dias !== null && dados.segundo?.media_dias !== undefined ? Number(dados.segundo.media_dias) : null,
        medianaDias: dados.segundo?.mediana_dias !== null && dados.segundo?.mediana_dias !== undefined ? Number(dados.segundo.mediana_dias) : null,
      },
      perda: {
        fechadas: p.fechadas, perdidas: p.perdidas,
        taxaPerda: p.fechadas > 0 ? Math.round((p.perdidas / p.fechadas) * 1000) / 10 : null,
        motivos: dados.motivos,
      },
    })
  })
}
