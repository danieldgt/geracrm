import type { FastifyInstance } from 'fastify'
import { exigirTenant } from '../../plugins/tenant.js'
import type { Sql } from '../../db/index.js'
import { exigirPapel } from './papel.js'

const PAGINA = 50
const BUSCA_MAX = 80
/** Janela aplicada quando a busca textual vem sem início de período (varrer a tabela inteira não é opção). */
export const JANELA_PADRAO_BUSCA_DIAS = 30
const ACOES_MAX = 20
// ISO 8601 com fuso obrigatório. Aceita até microssegundos: o cursor e a chave do
// detalhe carregam `criado_em` com a precisão do banco (ver `linhaParaApi`).
const REGEX_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/
const REGEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REGEX_CODIGO = /^[a-z0-9_.-]{1,60}$/i

/** Filtros já validados. `de` inclusivo; `ate` EXCLUSIVO (início do dia seguinte, na prática). */
export interface FiltrosAuditoria {
  readonly de: string | null
  readonly ate: string | null
  readonly atorId: string | null
  readonly acoes: readonly string[] | null
  readonly entidade: string | null
  readonly entidadeId: string | null
  readonly busca: string | null
}

export type ResultadoFiltros =
  | { readonly ok: true; readonly filtros: FiltrosAuditoria }
  | { readonly ok: false; readonly erro: string; readonly mensagem: string; readonly campos: readonly string[] }

const invalido = (campo: string, mensagem: string): ResultadoFiltros =>
  ({ ok: false, erro: 'auditoria.filtro_invalido', mensagem, campos: [campo] })

/** Texto vazio vira null; array (parâmetro repetido) vira `undefined` = inválido. */
function textoDe(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') return undefined
  return v.trim() || null
}

const isoValido = (s: string): boolean => REGEX_ISO.test(s) && !Number.isNaN(Date.parse(s))

/**
 * Valida os filtros da query. Pura: nada de banco aqui, para o teste cobrir cada regra.
 * Falha de filtro é 422 tipificado (CLAUDE.md) — nunca 500 e nunca filtro ignorado em silêncio.
 */
export function validarFiltros(q: Record<string, unknown>): ResultadoFiltros {
  const bruto: Record<string, string | null> = {}
  for (const campo of ['de', 'ate', 'atorId', 'acao', 'entidade', 'entidadeId', 'q']) {
    const t = textoDe(q[campo])
    if (t === undefined) return invalido(campo, `O filtro "${campo}" aceita um valor só.`)
    bruto[campo] = t
  }
  const de = bruto['de'] ?? null
  const ate = bruto['ate'] ?? null
  const atorId = bruto['atorId'] ?? null
  const entidade = bruto['entidade'] ?? null
  const entidadeId = bruto['entidadeId'] ?? null
  const busca = bruto['q'] ?? null
  const acaoBruta = bruto['acao'] ?? null

  if (de !== null && !isoValido(de)) return invalido('de', 'Início do período em ISO 8601 com fuso, por exemplo 2026-11-01T00:00:00-03:00.')
  if (ate !== null && !isoValido(ate)) return invalido('ate', 'Fim do período em ISO 8601 com fuso, por exemplo 2026-12-01T00:00:00-03:00.')
  if (de !== null && ate !== null && Date.parse(de) >= Date.parse(ate)) {
    return { ok: false, erro: 'auditoria.periodo_invalido', mensagem: 'O início do período precisa ser anterior ao fim.', campos: ['de', 'ate'] }
  }
  if (atorId !== null && !REGEX_UUID.test(atorId)) return invalido('atorId', 'Usuário inválido.')
  if (entidade !== null && !REGEX_CODIGO.test(entidade)) return invalido('entidade', 'Entidade inválida.')
  if (entidadeId !== null && entidadeId.length > 200) return invalido('entidadeId', 'Identificador da entidade longo demais.')
  if (busca !== null && busca.length > BUSCA_MAX) return invalido('q', `A busca aceita até ${BUSCA_MAX} caracteres.`)

  let acoes: string[] | null = null
  if (acaoBruta !== null) {
    acoes = acaoBruta.split(',').map((a) => a.trim()).filter((a) => a !== '')
    if (acoes.length > ACOES_MAX) return invalido('acao', `Escolha até ${ACOES_MAX} ações.`)
    if (acoes.some((a) => !REGEX_CODIGO.test(a))) return invalido('acao', 'Ação inválida.')
    if (acoes.length === 0) acoes = null
  }

  return {
    ok: true,
    filtros: { de, ate, atorId, acoes, entidade, entidadeId, busca },
  }
}

/** Escapa `%`, `_` e a própria barra para o termo entrar literal num ILIKE. */
export const escaparLike = (s: string): string => s.replace(/[\\%_]/g, '\\$&')

function decodificarCursor(cursor: string): { em: string; id: string } | null {
  const [em, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('§')
  if (!em || !id || !isoValido(em) || !REGEX_UUID.test(id)) return null
  return { em, id }
}

interface LinhaAuditoria {
  id: string; criado_em: string; acao: string; entidade: string; entidade_id: string | null
  dados: unknown; ator_nome: string | null
}

const linhaParaApi = (l: LinhaAuditoria) => ({
  id: l.id, criadoEm: l.criado_em, acao: l.acao, entidade: l.entidade,
  entidadeId: l.entidade_id, atorNome: l.ator_nome, dados: l.dados,
})

/**
 * Leitura do rastro de auditoria (EP-07 / PLT-05).
 *
 * ⚠️ Paginado por CURSOR, nunca top-N cru (CLAUDE.md). O rastro só cresce — uma
 * conta antiga tem centenas de milhares de linhas. Cursor `(criado_em, id)` para
 * trás, que é exatamente a ordem da PK particionada `(tenant_id, criado_em, id)`,
 * então a paginação não faz sort nem OFFSET profundo. Os filtros entram com AND
 * e não mexem no cursor: a página seguinte continua do mesmo ponto.
 *
 * ⚠️ `criado_em` sai com MICROSSEGUNDOS (texto ISO, não `Date`). Um `Date` trunca
 * para milissegundo: duas linhas no mesmo ms perdiam a segunda no cursor, e a
 * chave do detalhe deixava de bater com a linha. E o parâmetro vai como TEXTO
 * (`::text::timestamptz`): cast direto `$1::timestamptz` faz o driver truncar a fração.
 *
 * `de`/`ate` também podam partições: a tabela é particionada por mês (0004).
 */
export async function rotasAuditoria(app: FastifyInstance): Promise<void> {
  const selecao = (tx: Sql) => tx`
    SELECT a.id,
           to_char(a.criado_em AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS criado_em,
           a.acao, a.entidade, a.entidade_id, a.dados, u.nome AS ator_nome
      FROM auditoria a
      LEFT JOIN usuario u ON u.tenant_id = a.tenant_id AND u.id = a.ator_id`

  app.get('/v1/auditoria', { preHandler: [exigirTenant, exigirPapel('gestor')] }, async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, unknown>

    const v = validarFiltros(q)
    if (!v.ok) return reply.code(422).send({ erro: v.erro, mensagem: v.mensagem, campos: v.campos })
    const f = v.filtros

    let cursor: { em: string; id: string } | null = null
    if (typeof q['cursor'] === 'string' && q['cursor']) {
      cursor = decodificarCursor(q['cursor'])
      if (!cursor) return reply.code(422).send({ erro: 'cursor.invalido', mensagem: 'Cursor inválido.' })
    }
    const padraoBusca = f.busca === null ? null : `%${escaparLike(f.busca)}%`
    // ⚠️ `q` é ILIKE sobre `dados::text`: sem piso de data varre TODAS as partições. Sem `de`, a busca
    //    ganha a janela padrão (30 dias antes de `ate`, ou de agora) e a resposta diz `janelaPadrao: true`.
    const janelaPadrao = padraoBusca !== null && f.de === null

    // Pede uma linha a mais para saber se há próxima página sem um count separado.
    const linhas = await req.comTenant((tx) => tx<LinhaAuditoria[]>`
      ${selecao(tx)}
       WHERE a.tenant_id = tenant_atual()
         AND ${f.entidadeId ? tx`a.entidade_id = ${f.entidadeId}` : tx`true`}
         AND ${f.entidade ? tx`a.entidade = ${f.entidade}` : tx`true`}
         AND ${f.atorId ? tx`a.ator_id = ${f.atorId}::uuid` : tx`true`}
         AND ${f.acoes ? tx`a.acao = ANY(${[...f.acoes]}::text[])` : tx`true`}
         AND ${f.de ? tx`a.criado_em >= ${f.de}::text::timestamptz`
               : janelaPadrao
                 ? tx`a.criado_em >= coalesce(${f.ate ?? null}::text::timestamptz, now()) - make_interval(days => ${JANELA_PADRAO_BUSCA_DIAS})`
                 : tx`true`}
         AND ${f.ate ? tx`a.criado_em < ${f.ate}::text::timestamptz` : tx`true`}
         AND ${padraoBusca ? tx`(a.acao ILIKE ${padraoBusca} OR a.dados::text ILIKE ${padraoBusca})` : tx`true`}
         AND ${cursor === null ? tx`true` : tx`
               (a.criado_em, a.id) < (${cursor.em}::text::timestamptz, ${cursor.id}::uuid)`}
       ORDER BY a.criado_em DESC, a.id DESC
       LIMIT ${PAGINA + 1}`)

    const temMais = linhas.length > PAGINA
    const pagina = temMais ? linhas.slice(0, PAGINA) : linhas
    const ultimo = pagina[pagina.length - 1]
    const proximoCursor = temMais && ultimo
      ? Buffer.from(`${ultimo.criado_em}§${ultimo.id}`).toString('base64url')
      : null

    return reply.send({ itens: pagina.map(linhaParaApi), proximoCursor, janelaPadrao, janelaDias: janelaPadrao ? JANELA_PADRAO_BUSCA_DIAS : null })
  })

  // Detalhe de UM evento, com o JSON completo. A chave é a PK `(tenant_id, criado_em, id)`:
  // `criado_em` no caminho deixa o planner podar as partições.
  app.get('/v1/auditoria/:criadoEm/:id', { preHandler: [exigirTenant, exigirPapel('gestor')] }, async (req, reply) => {
    const { criadoEm, id } = req.params as { criadoEm: string; id: string }
    if (!isoValido(criadoEm) || !REGEX_UUID.test(id)) {
      return reply.code(422).send({ erro: 'auditoria.chave_invalida', mensagem: 'Chave de evento inválida.', campos: ['criadoEm', 'id'] })
    }
    const [linha] = await req.comTenant((tx) => tx<LinhaAuditoria[]>`
      ${selecao(tx)}
       WHERE a.tenant_id = tenant_atual()
         AND a.criado_em = ${criadoEm}::text::timestamptz
         AND a.id = ${id}::uuid`)
    if (!linha) return reply.code(404).send({ erro: 'auditoria.nao_encontrada', mensagem: 'Evento não encontrado.' })
    return reply.send(linhaParaApi(linha))
  })
}
