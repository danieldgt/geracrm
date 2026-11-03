import type { FastifyInstance } from 'fastify'
import { exigirTenant } from '../../plugins/tenant.js'
import { fusoSeguro } from '../plataforma/fuso.js'
import { condicaoOportunidade, escopoDaRequisicao } from '../plataforma/escopo.js'
import { garantirEtapasFunil } from './funil-modelos.js'
import { SEM_DONO, SEM_FILIAL } from './funil-filtros.js'

const LIMITE_GRUPOS = 200

const ROTULO_SEM: Record<string, string> = { [SEM_DONO]: 'Sem dono', [SEM_FILIAL]: 'Sem filial' }

/**
 * Panorama do funil (B1): um cartão por grupo (filial ou vendedor dono da carteira) com os selos e a
 * contagem por etapa. Tudo por AGREGAÇÃO com índice (0131) — nunca lista cards.
 *
 * Decisões:
 *  - `ativos` = oportunidades abertas; `ganhosMes`/`perdidosMes` = fechadas no mês corrente NO FUSO DO TENANT.
 *  - `semProximoPasso` = abertas cujo contato não tem tarefa aberta nem reunião agendada daqui para frente.
 *  - Filial = filial do RESPONSÁVEL (`usuario_filial`); quem tem papel em duas filiais conta nas duas.
 *    Responsável sem filial => grupo `sem-filial`; sem responsável => `sem-dono`.
 *  - Escopo (D3): vale o mesmo recorte do board; quem está no escopo `carteira` vê só o PRÓPRIO grupo.
 */
export async function rotasFunilPanorama(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { agrupar?: string } }>('/v1/funil/panorama', { preHandler: exigirTenant }, async (req, reply) => {
    const agrupar = req.query.agrupar ?? 'filial'
    if (agrupar !== 'filial' && agrupar !== 'vendedor') {
      return reply.code(422).send({ erro: 'panorama.agrupar_invalido', mensagem: 'Agrupe por filial ou vendedor.' })
    }

    const r = await req.comTenant(async (tx) => {
      await garantirEtapasFunil(tx)
      const escopo = await escopoDaRequisicao(tx, req)
      const [t] = await tx<{ fuso: string | null }[]>`SELECT fuso FROM tenant WHERE id = tenant_atual()`
      const fuso = fusoSeguro(t?.fuso)
      // ⚠️ Fuso validado em TS antes do AT TIME ZONE (padrão do módulo).
      const inicioMes = tx`(date_trunc('month', now() AT TIME ZONE ${fuso}::text) AT TIME ZONE ${fuso}::text)`
      const fimMes = tx`((date_trunc('month', now() AT TIME ZONE ${fuso}::text) + interval '1 month') AT TIME ZONE ${fuso}::text)`
      const soProprio = escopo.tipo === 'carteira' && escopo.usuarioId
        ? tx`AND o.responsavel_id = ${escopo.usuarioId}::uuid` : tx``

      const grupo = agrupar === 'vendedor'
        ? tx`COALESCE(o.responsavel_id::text, ${SEM_DONO}::text)`
        : tx`CASE WHEN o.responsavel_id IS NULL THEN ${SEM_DONO}::text
                  WHEN uf.filial_id IS NULL THEN ${SEM_FILIAL}::text
                  ELSE uf.filial_id::text END`
      const juncao = agrupar === 'filial'
        ? tx`LEFT JOIN usuario_filial uf ON uf.tenant_id = o.tenant_id AND uf.usuario_id = o.responsavel_id
                                        AND uf.filial_id IS NOT NULL`
        : tx``
      const periodo = tx`(o.estado = 'aberta'
                          OR (o.estado IN ('ganha','perdida') AND o.fechada_em >= ${inicioMes} AND o.fechada_em < ${fimMes}))`

      const grupos = await tx<{
        chave: string; ativos: number; ganhos: number; perdidos: number; sem_passo: number
      }[]>`
        SELECT ${grupo} AS chave,
               count(*) FILTER (WHERE o.estado = 'aberta')::int AS ativos,
               count(*) FILTER (WHERE o.estado = 'ganha')::int AS ganhos,
               count(*) FILTER (WHERE o.estado = 'perdida')::int AS perdidos,
               count(*) FILTER (WHERE o.estado = 'aberta'
                 AND NOT EXISTS (SELECT 1 FROM tarefa ta WHERE ta.tenant_id = o.tenant_id
                                   AND ta.contato_id = o.contato_id AND ta.estado = 'aberta')
                 AND NOT EXISTS (SELECT 1 FROM evento_agenda ev WHERE ev.tenant_id = o.tenant_id
                                   AND ev.contato_id = o.contato_id AND ev.status = 'agendado' AND ev.inicio >= now())
               )::int AS sem_passo
          FROM oportunidade o ${juncao}
         WHERE o.tenant_id = tenant_atual() AND ${condicaoOportunidade(tx, escopo, 'o')} ${soProprio}
           AND ${periodo}
         GROUP BY 1
         ORDER BY ativos DESC, chave
         LIMIT ${LIMITE_GRUPOS + 1}`
      const truncado = grupos.length > LIMITE_GRUPOS
      const visiveis = truncado ? grupos.slice(0, LIMITE_GRUPOS) : grupos
      const chaves = visiveis.map((g) => g.chave)

      const etapas = await tx<{ id: string }[]>`
        SELECT id FROM funil_etapa WHERE tenant_id = tenant_atual() AND ativo AND tipo = 'aberto' ORDER BY ordem`
      const porEtapa = chaves.length === 0 ? [] : await tx<{ chave: string; etapa_id: string; total: number }[]>`
        SELECT x.chave, x.etapa_id, x.total FROM (
          SELECT ${grupo} AS chave, o.etapa_id, count(*)::int AS total
            FROM oportunidade o ${juncao}
           WHERE o.tenant_id = tenant_atual() AND o.estado = 'aberta'
             AND ${condicaoOportunidade(tx, escopo, 'o')} ${soProprio}
           GROUP BY 1, 2) x
         WHERE x.chave = ANY(${chaves}::text[])`

      const uuids = chaves.filter((c) => c !== SEM_DONO && c !== SEM_FILIAL)
      const nomes = uuids.length === 0 ? [] : agrupar === 'vendedor'
        ? await tx<{ id: string; nome: string }[]>`
            SELECT id::text AS id, nome FROM usuario WHERE tenant_id = tenant_atual() AND id = ANY(${uuids}::uuid[])`
        : await tx<{ id: string; nome: string }[]>`
            SELECT id::text AS id, nome FROM filial WHERE tenant_id = tenant_atual() AND id = ANY(${uuids}::uuid[])`
      return { visiveis, truncado, etapas, porEtapa, nomes }
    })

    const nomePorId = new Map(r.nomes.map((n) => [n.id, n.nome]))
    const totalPor = new Map(r.porEtapa.map((p) => [`${p.chave}|${p.etapa_id}`, p.total]))
    return reply.send({
      agrupar,
      itens: r.visiveis.map((g) => ({
        chave: g.chave,
        rotulo: ROTULO_SEM[g.chave] ?? nomePorId.get(g.chave) ?? 'Sem nome',
        ativos: g.ativos, ganhosMes: g.ganhos, perdidosMes: g.perdidos, semProximoPasso: g.sem_passo,
        porEtapa: r.etapas.map((e) => ({ etapaId: e.id, total: totalPor.get(`${g.chave}|${e.id}`) ?? 0 })),
      })),
      truncado: r.truncado,
    })
  })
}
