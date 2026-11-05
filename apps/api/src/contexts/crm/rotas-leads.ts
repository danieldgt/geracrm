import type { FastifyInstance } from 'fastify'
import { exigirTenant } from '../../plugins/tenant.js'
import { condicaoContato, contatoNoEscopo, escopoDaRequisicao } from '../plataforma/escopo.js'
import { atorDaRequisicao } from '../atendimento/rotas-fila.js'
import { qualificarContato } from './qualificacao.js'

const PAGINA = 50 // cards por página de coluna (kanban paginado por coluna, ADR)

/**
 * CRM (Leads) — kanban de QUALIFICAÇÃO do lead novo (eixo negociação/aquisição).
 *
 * ⚠️ NÃO é o Funil de relacionamento (`oportunidade`/`funil_etapa`) nem o CRM
 * Avançado (nº de pedidos/RFV). Roda sobre `contato.qualificado`: as três
 * colunas são derivadas — Leads (não avaliado), Qualificados, Descartados.
 * Mover = mudar a qualificação (last-write-wins; baixo risco, sem `versao`).
 *
 * ⚠️ Paginação POR COLUNA por cursor `(criado_em, id)` — a coluna "Leads" tem
 * dezenas de milhares. Nunca lista ilimitada. Card só metadados.
 */
const CHAVES = ['novo', 'qualificado', 'descartado'] as const
type Chave = (typeof CHAVES)[number]
const NOME: Record<Chave, string> = { novo: 'Leads', qualificado: 'Qualificados', descartado: 'Descartados' }

export async function rotasLeads(app: FastifyInstance): Promise<void> {
  /** As três colunas + contagem de cada uma (só contatos ativos). */
  app.get('/v1/leads/colunas', { preHandler: exigirTenant }, async (req, reply) => {
    // ⚠️ A contagem conta o que a coluna MOSTRA (escopo D3).
    const [c] = await req.comTenant(async (tx) => {
      const escopo = await escopoDaRequisicao(tx, req)
      return tx<{ novo: number; qualificado: number; descartado: number }[]>`
      SELECT count(*) FILTER (WHERE c.qualificado IS NULL)  ::int AS novo,
             count(*) FILTER (WHERE c.qualificado IS TRUE)  ::int AS qualificado,
             count(*) FILTER (WHERE c.qualificado IS FALSE) ::int AS descartado
        FROM contato c
       WHERE c.tenant_id = tenant_atual() AND c.ativo AND ${condicaoContato(tx, escopo, 'c')}`
    })
    return reply.send({
      colunas: CHAVES.map((chave) => ({ chave, nome: NOME[chave], total: c ? c[chave] : 0 })),
    })
  })

  /** Cards de uma coluna, paginados por cursor `(criado_em, id)` desc. */
  app.get<{ Params: { chave: string }; Querystring: { cursor?: string } }>(
    '/v1/leads/coluna/:chave',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const chave = req.params.chave as Chave
      if (!CHAVES.includes(chave)) return reply.code(422).send({ erro: 'coluna.invalida' })

      let curEm: string | null = null
      let curId: string | null = null
      if (req.query.cursor) {
        const [em, id] = Buffer.from(req.query.cursor, 'base64url').toString('utf8').split('§')
        if (!em || !id) return reply.code(422).send({ erro: 'cursor.invalido' })
        curEm = em; curId = id
      }

      const linhas = await req.comTenant(async (tx) => {
        const escopo = await escopoDaRequisicao(tx, req)
        return tx<{
        id: string; nome: string; qtd_vendas: number; ultimo_toque_em: Date | null
        descarte_motivo: string | null
        criado_em: Date; telefone: string | null; uf: string | null
        responsavel: string | null; conversa_id: string | null
      }[]>`
        SELECT c.id, c.nome, c.qtd_vendas, c.ultimo_toque_em, c.criado_em, c.descarte_motivo,
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
                 ORDER BY cv.ultima_mensagem_em DESC NULLS LAST, cv.id DESC LIMIT 1) AS conversa_id
          FROM contato c
         WHERE c.tenant_id = tenant_atual() AND c.ativo
           AND ${condicaoContato(tx, escopo, 'c')}
           AND ${chave === 'novo' ? tx`c.qualificado IS NULL`
                : chave === 'qualificado' ? tx`c.qualificado IS TRUE`
                : tx`c.qualificado IS FALSE`}
           AND ${curEm === null ? tx`true`
                : tx`(c.criado_em, c.id) < (${curEm}::text::timestamptz, ${curId}::uuid)`}
         ORDER BY c.criado_em DESC, c.id DESC
         LIMIT ${PAGINA + 1}`
      })

      const temMais = linhas.length > PAGINA
      const pagina = temMais ? linhas.slice(0, PAGINA) : linhas
      const ultimo = pagina[pagina.length - 1]
      const proximoCursor = temMais && ultimo
        ? Buffer.from(`${ultimo.criado_em.toISOString()}§${ultimo.id}`).toString('base64url') : null

      return reply.send({
        itens: pagina.map((l) => ({
          contatoId: l.id, nome: l.nome, telefone: l.telefone, uf: l.uf,
          responsavel: l.responsavel, qtdVendas: l.qtd_vendas,
          ultimoToqueEm: l.ultimo_toque_em, conversaId: l.conversa_id,
          // "sem_resposta" = descartado pelo sistema no fim da cadência (G5); o card mostra o selo.
          descarteMotivo: l.descarte_motivo,
        })),
        proximoCursor,
      })
    },
  )

  /** Mover o lead entre colunas = mudar a qualificação (CTT-05). */
  app.post<{ Params: { contatoId: string }; Body: { estado?: string } }>(
    '/v1/leads/:contatoId/qualificar',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const estado = req.body?.estado
      if (estado !== 'novo' && estado !== 'qualificado' && estado !== 'descartado') {
        return reply.code(422).send({ erro: 'estado.invalido' })
      }
      // Mesmo caminho de domínio do descarte automático (G5): `qualificarContato`.
      const r = await req.comTenant(async (tx) => {
        // ⚠️ Fora do escopo (D3) = 404, como inexistente.
        if (!(await contatoNoEscopo(tx, await escopoDaRequisicao(tx, req), req.params.contatoId))) return { tipo: 'nao_encontrado' as const }
        const atorId = await atorDaRequisicao(tx, req)
        return qualificarContato(tx, { contatoId: req.params.contatoId, estado, atorId, atorStaff: req.atorStaff === true })
      })
      if (r.tipo === 'nao_encontrado') return reply.code(404).send({ erro: 'contato.nao_encontrado' })
      return reply.send({ ok: true, estado })
    },
  )
}
