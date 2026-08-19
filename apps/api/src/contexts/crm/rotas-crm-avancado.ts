import type { FastifyInstance } from 'fastify'
import { classificarRfv } from '@geracrm/shared'
import { exigirTenant } from '../../plugins/tenant.js'
import type { Sql } from '../../db/index.js'

const PAGINA = 50 // cards por página de coluna (kanban paginado por coluna, ADR)

/**
 * CRM Avançado — consolidação da base pelo eixo CICLO DE VIDA / frequência.
 *
 * ⚠️ Board de LEITURA: as colunas de frequência (Leads / 1º / 2 / 3+ Pedidos)
 * são derivadas de `contato.qtd_vendas` — não há drag entre elas, porque não se
 * forja uma compra (skill funil-de-vendas §6). A única ação é Descartar/Reabrir
 * (reusa `/v1/leads/:id/qualificar`) e abrir a conversa. Cada card traz o
 * segmento RFV (mesma régua `classificarRfv`), a foto de onde o cliente está.
 *
 * Prioridade dos baldes: Descartado > Representante > por nº de pedidos. Assim
 * a base particiona sem contato sumir nem contar duas vezes.
 */
const COLUNAS = [
  { chave: 'leads', nome: 'Leads' },
  { chave: 'p1', nome: '1º Pedido' },
  { chave: 'p2', nome: '2 Pedidos' },
  { chave: 'p3', nome: '3+ Pedidos' },
  { chave: 'representantes', nome: 'Representantes' },
  { chave: 'descartados', nome: 'Descartados' },
] as const
type Chave = (typeof COLUNAS)[number]['chave']
const CHAVES = COLUNAS.map((c) => c.chave)

/** Fragmento de filtro do balde (prioridade embutida). `nd` = não descartado. */
function predicado(tx: Sql, chave: Chave) {
  const nd = tx`c.qualificado IS DISTINCT FROM FALSE`
  const semRep = tx`NOT c.representante AND ${nd}`
  switch (chave) {
    case 'descartados': return tx`c.qualificado IS FALSE`
    case 'representantes': return tx`c.representante AND ${nd}`
    case 'leads': return tx`c.qtd_vendas = 0 AND ${semRep}`
    case 'p1': return tx`c.qtd_vendas = 1 AND ${semRep}`
    case 'p2': return tx`c.qtd_vendas = 2 AND ${semRep}`
    case 'p3': return tx`c.qtd_vendas >= 3 AND ${semRep}`
  }
}

export async function rotasCrmAvancado(app: FastifyInstance): Promise<void> {
  /** As colunas + contagem de cada balde (base ativa). */
  app.get('/v1/crm-avancado/colunas', { preHandler: exigirTenant }, async (req, reply) => {
    const [c] = await req.comTenant((tx) => tx<Record<Chave, number>[]>`
      SELECT count(*) FILTER (WHERE qualificado IS FALSE) ::int AS descartados,
             count(*) FILTER (WHERE representante AND qualificado IS DISTINCT FROM FALSE) ::int AS representantes,
             count(*) FILTER (WHERE qtd_vendas = 0 AND NOT representante AND qualificado IS DISTINCT FROM FALSE) ::int AS leads,
             count(*) FILTER (WHERE qtd_vendas = 1 AND NOT representante AND qualificado IS DISTINCT FROM FALSE) ::int AS p1,
             count(*) FILTER (WHERE qtd_vendas = 2 AND NOT representante AND qualificado IS DISTINCT FROM FALSE) ::int AS p2,
             count(*) FILTER (WHERE qtd_vendas >= 3 AND NOT representante AND qualificado IS DISTINCT FROM FALSE) ::int AS p3
        FROM contato
       WHERE tenant_id = tenant_atual() AND ativo`)
    return reply.send({ colunas: COLUNAS.map((col) => ({ ...col, total: c ? c[col.chave] : 0 })) })
  })

  /** Cards de uma coluna, paginados por `coalesce(ultima_venda_em, criado_em)` desc. */
  app.get<{ Params: { chave: string }; Querystring: { cursor?: string } }>(
    '/v1/crm-avancado/coluna/:chave',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const chave = req.params.chave as Chave
      if (!CHAVES.includes(chave)) return reply.code(422).send({ erro: 'coluna.invalida' })

      let curOrd: string | null = null
      let curId: string | null = null
      if (req.query.cursor) {
        const [o, id] = Buffer.from(req.query.cursor, 'base64url').toString('utf8').split('§')
        if (!o || !id) return reply.code(422).send({ erro: 'cursor.invalido' })
        curOrd = o; curId = id
      }

      const linhas = await req.comTenant((tx) => tx<{
        id: string; nome: string; qtd_vendas: number; total_vendas_centavos: string
        ultima_venda_em: Date | null; ultimo_toque_em: Date | null; representante: boolean
        ordem: Date; telefone: string | null; uf: string | null; responsavel: string | null
        conversa_id: string | null; dias_sem_comprar: number | null; atraso_relativo: number | null
      }[]>`
        SELECT c.id, c.nome, c.qtd_vendas, c.total_vendas_centavos::text,
               c.ultima_venda_em, c.ultimo_toque_em, c.representante,
               coalesce(c.ultima_venda_em, c.criado_em) AS ordem,
               (SELECT t.e164 FROM contato_telefone t
                 WHERE t.tenant_id = c.tenant_id AND t.contato_id = c.id
                 ORDER BY t.principal DESC, t.seq LIMIT 1) AS telefone,
               (SELECT e.uf FROM contato_endereco e
                 WHERE e.tenant_id = c.tenant_id AND e.contato_id = c.id AND e.uf IS NOT NULL
                 ORDER BY e.principal DESC, e.seq LIMIT 1) AS uf,
               (SELECT u.nome FROM carteira_atribuicao ca
                  JOIN usuario u ON u.tenant_id = ca.tenant_id AND u.id = ca.usuario_id
                 WHERE ca.tenant_id = c.tenant_id AND ca.contato_id = c.id AND ca.ate IS NULL
                 LIMIT 1) AS responsavel,
               (SELECT cv.id FROM conversa cv
                 WHERE cv.tenant_id = c.tenant_id AND cv.contato_id = c.id
                 ORDER BY cv.ultima_mensagem_em DESC NULLS LAST, cv.id DESC LIMIT 1) AS conversa_id,
               mc.dias_sem_comprar, mc.atraso_relativo
          FROM contato c
          LEFT JOIN metricas_contato mc ON mc.contato_id = c.id
         WHERE c.tenant_id = tenant_atual() AND c.ativo AND ${predicado(tx, chave)}
           AND ${curOrd === null ? tx`true`
                : tx`(coalesce(c.ultima_venda_em, c.criado_em), c.id) < (${curOrd}::timestamptz, ${curId}::uuid)`}
         ORDER BY coalesce(c.ultima_venda_em, c.criado_em) DESC, c.id DESC
         LIMIT ${PAGINA + 1}`)

      const temMais = linhas.length > PAGINA
      const pagina = temMais ? linhas.slice(0, PAGINA) : linhas
      const ultimo = pagina[pagina.length - 1]
      const proximoCursor = temMais && ultimo
        ? Buffer.from(`${ultimo.ordem.toISOString()}§${ultimo.id}`).toString('base64url') : null

      return reply.send({
        itens: pagina.map((l) => {
          // Segmento RFV só faz sentido com compra (≥1 venda); Leads não têm.
          const seg = l.qtd_vendas >= 1
            ? classificarRfv({ qtdVendas: l.qtd_vendas, diasSemComprar: l.dias_sem_comprar, atrasoRelativo: l.atraso_relativo })
            : null
          return {
            contatoId: l.id, nome: l.nome, telefone: l.telefone, uf: l.uf, responsavel: l.responsavel,
            qtdVendas: l.qtd_vendas, totalCentavos: Number(l.total_vendas_centavos),
            ultimaVendaEm: l.ultima_venda_em, ultimoToqueEm: l.ultimo_toque_em,
            representante: l.representante, conversaId: l.conversa_id,
            segmento: seg ? { codigo: seg.codigo, rotulo: seg.rotulo } : null,
          }
        }),
        proximoCursor,
      })
    },
  )
}
