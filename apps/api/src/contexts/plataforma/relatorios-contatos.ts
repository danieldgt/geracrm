import type postgres from 'postgres'
import type { Sql } from '../../db/index.js'
import type { PeriodoResolvido } from './periodo-relatorio.js'
import { condicaoContato, type Escopo } from './escopo.js'
import { taxaDe } from './rotas-relatorios.js'

/**
 * COORTE DETALHADA DE CONTATOS (raia E3) — a base de Contatos completo, Visão geral, Raio-X e Desempenho.
 *
 * Coorte = contatos CRIADOS no período (fuso do tenant), ativos, sem simulação, dentro do escopo da D3 — a
 * mesma do E1 (`contatosPorDimensao`). Cada contato sai com os atributos que os relatórios cruzam:
 *   vendedor        carteira vigente; filial = `contato.filial_id` ou a filial do vendedor (menor id, determinístico);
 *   tipo de pessoa  documento fiscal (cpf/cnpj) ou o primeiro documento; `null` = sem documento;
 *   UF/cidade       endereço principal; telefone = o principal (e164);
 *   formulário      o PRIMEIRO formulário que o contato respondeu (a origem de captação);
 *   pedidos/valor   pedidos EFETIVADOS no período (régua de "venda" da E2); convertido = pedidos > 0.
 * Todo acesso passa por `tenant_atual()` (RLS) e por período limitado (<= 366 dias).
 */
export const CSV_MAX_LINHAS = 1000
const LOTE_CSV = 250

export type QualificacaoContato = 'novo' | 'qualificado' | 'descartado'
export type TipoPessoa = 'cpf' | 'cnpj' | 'sem'

export interface FiltrosContatos {
  qualificacao?: QualificacaoContato
  origemId?: string
  vendedorId?: string
  filialId?: string
  formularioId?: string
  uf?: string
  tipoPessoa?: TipoPessoa
  convertido?: boolean
  busca?: string
}

type Fragmento = postgres.PendingQuery<postgres.Row[]>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const ISO_ESTRITO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/

export function ehUuid(v: string): boolean { return UUID.test(v) }

/** Valida os filtros da query (função pura). Devolve o filtro ou o NOME do campo inválido. */
export function lerFiltros(q: Record<string, string | undefined>): { filtros: FiltrosContatos } | { campoInvalido: string } {
  const f: FiltrosContatos = {}
  if (q.qualificacao) {
    if (!['novo', 'qualificado', 'descartado'].includes(q.qualificacao)) return { campoInvalido: 'qualificacao' }
    f.qualificacao = q.qualificacao as QualificacaoContato
  }
  const ids = [['origemId', 'sem-origem'], ['vendedorId', 'sem-vendedor'], ['filialId', 'sem-filial'], ['formularioId', 'sem-formulario']] as const
  for (const [campo, sem] of ids) {
    const v = q[campo]
    if (v === undefined || v === '') continue
    if (!ehUuid(v) && v !== sem) return { campoInvalido: campo }
    f[campo] = v
  }
  if (q.uf) {
    if (!/^[A-Za-z]{2}$/.test(q.uf)) return { campoInvalido: 'uf' }
    f.uf = q.uf.toUpperCase()
  }
  if (q.tipoPessoa) {
    if (!['cpf', 'cnpj', 'sem'].includes(q.tipoPessoa)) return { campoInvalido: 'tipoPessoa' }
    f.tipoPessoa = q.tipoPessoa as TipoPessoa
  }
  if (q.convertido) {
    if (q.convertido !== 'sim' && q.convertido !== 'nao') return { campoInvalido: 'convertido' }
    f.convertido = q.convertido === 'sim'
  }
  if (q.busca !== undefined && q.busca !== '') {
    const b = q.busca.trim()
    if (b.length < 2 || b.length > 60) return { campoInvalido: 'busca' }
    f.busca = b
  }
  return { filtros: f }
}

/** Cursor opaco (criado_em ISO, id): `base64url("<iso>|<uuid>")`. */
export function montarCursor(emIso: string, id: string): string {
  return Buffer.from(`${emIso}|${id}`).toString('base64url')
}
export function lerCursor(c: string): { em: string; id: string } | null {
  const [em, id, resto] = Buffer.from(c, 'base64url').toString().split('|')
  if (resto !== undefined || !em || !id || !ehUuid(id) || !ISO_ESTRITO.test(em) || Number.isNaN(Date.parse(em))) return null
  return { em, id }
}

/** A coorte com todos os atributos (corpo de CTE `k`). */
export function coorteDetalhada(tx: Sql, p: PeriodoResolvido, escopo: Escopo): Fragmento {
  return tx`
    SELECT c.id, c.nome, c.email, c.criado_em, c.qualificado, c.origem_id, o.nome AS origem,
           ca.usuario_id AS vendedor_id, u.nome AS vendedor,
           coalesce(c.filial_id, fv.filial_id) AS filial_id, fi.nome AS filial,
           d.tipo AS tipo_doc, e.uf, e.cidade, tel.e164 AS telefone,
           fr.formulario_id, fr.formulario,
           coalesce(cp.pedidos, 0)::int AS pedidos, coalesce(cp.valor, 0) AS valor
      FROM contato c
      LEFT JOIN origem o ON o.tenant_id = c.tenant_id AND o.id = c.origem_id
      LEFT JOIN carteira_atribuicao ca ON ca.tenant_id = c.tenant_id AND ca.contato_id = c.id AND ca.ate IS NULL
      LEFT JOIN usuario u ON u.tenant_id = ca.tenant_id AND u.id = ca.usuario_id
      LEFT JOIN LATERAL (SELECT x.filial_id FROM usuario_filial x
                          WHERE x.tenant_id = c.tenant_id AND x.usuario_id = ca.usuario_id AND x.filial_id IS NOT NULL
                            AND ${escopo.tipo === 'filial' ? tx`x.filial_id IN ${tx(escopo.filialIds)}` : tx`true`}
                          ORDER BY x.filial_id LIMIT 1) fv ON true
      LEFT JOIN filial fi ON fi.tenant_id = c.tenant_id AND fi.id = coalesce(c.filial_id, fv.filial_id)
      LEFT JOIN LATERAL (SELECT x.tipo FROM contato_documento x
                          WHERE x.tenant_id = c.tenant_id AND x.contato_id = c.id
                          ORDER BY x.fiscal DESC, x.seq LIMIT 1) d ON true
      LEFT JOIN contato_endereco e ON e.tenant_id = c.tenant_id AND e.contato_id = c.id AND e.principal
      LEFT JOIN contato_telefone tel ON tel.tenant_id = c.tenant_id AND tel.contato_id = c.id AND tel.principal
      LEFT JOIN LATERAL (SELECT r.formulario_id, f.nome AS formulario
                           FROM formulario_resposta r
                           JOIN formulario f ON f.tenant_id = r.tenant_id AND f.id = r.formulario_id
                          WHERE r.tenant_id = c.tenant_id AND r.contato_id = c.id
                          ORDER BY r.criado_em, r.id LIMIT 1) fr ON true
      LEFT JOIN LATERAL (SELECT count(*) AS pedidos, sum(pd.total_centavos) AS valor
                           FROM pedido pd
                          WHERE pd.tenant_id = c.tenant_id AND pd.contato_id = c.id AND pd.estado = 'efetivado'
                            AND pd.efetivado_em >= ${p.desde} AND pd.efetivado_em < ${p.ate}) cp ON true
     WHERE c.tenant_id = tenant_atual() AND c.ativo AND coalesce(c.origem_carga, '') <> 'simulacao'
       AND c.criado_em >= ${p.desde} AND c.criado_em < ${p.ate}
       AND ${condicaoContato(tx, escopo, 'c')}`
}

/** Condições dos filtros sobre `k` (a coorte detalhada). */
export function condicoesFiltro(tx: Sql, f: FiltrosContatos): Fragmento {
  const cs: Fragmento[] = [tx`true`]
  if (f.qualificacao === 'novo') cs.push(tx`k.qualificado IS NULL`)
  if (f.qualificacao === 'qualificado') cs.push(tx`k.qualificado`)
  if (f.qualificacao === 'descartado') cs.push(tx`k.qualificado = false`)
  const porId = (v: string | undefined, coluna: string, sem: string): void => {
    if (v === undefined) return
    cs.push(v === sem ? tx`k.${tx(coluna)} IS NULL` : tx`k.${tx(coluna)} = ${v}::uuid`)
  }
  porId(f.origemId, 'origem_id', 'sem-origem')
  porId(f.vendedorId, 'vendedor_id', 'sem-vendedor')
  porId(f.filialId, 'filial_id', 'sem-filial')
  porId(f.formularioId, 'formulario_id', 'sem-formulario')
  if (f.uf) cs.push(tx`upper(k.uf) = ${f.uf}`)
  if (f.tipoPessoa === 'sem') cs.push(tx`k.tipo_doc IS NULL`)
  else if (f.tipoPessoa) cs.push(tx`k.tipo_doc = ${f.tipoPessoa}`)
  if (f.convertido === true) cs.push(tx`k.pedidos > 0`)
  if (f.convertido === false) cs.push(tx`k.pedidos = 0`)
  if (f.busca) cs.push(tx`k.nome ILIKE ${'%' + f.busca.replace(/[\\%_]/g, '\\$&') + '%'}`)
  return cs.reduce((a, b) => tx`${a} AND ${b}`)
}

export interface LinhaContato {
  readonly id: string
  readonly nome: string
  readonly telefone: string | null
  readonly email: string | null
  readonly tipoPessoa: 'cpf' | 'cnpj' | null
  readonly uf: string | null
  readonly cidade: string | null
  readonly origem: string | null
  readonly vendedor: string | null
  readonly filial: string | null
  readonly qualificacao: QualificacaoContato
  readonly formulario: string | null
  readonly criadoEm: string
  readonly convertido: boolean
  readonly pedidos: number
  readonly valorCentavos: number
}

interface Bruta {
  id: string; nome: string; telefone: string | null; email: string | null; tipo_doc: 'cpf' | 'cnpj' | null
  uf: string | null; cidade: string | null; origem: string | null; vendedor: string | null; filial: string | null
  qualificado: boolean | null; formulario: string | null; em_txt: string; pedidos: number; valor: string
}

function paraLinha(b: Bruta): LinhaContato {
  return {
    id: b.id, nome: b.nome, telefone: b.telefone, email: b.email, tipoPessoa: b.tipo_doc,
    uf: b.uf?.trim() || null, cidade: b.cidade, origem: b.origem, vendedor: b.vendedor, filial: b.filial,
    qualificacao: b.qualificado === null ? 'novo' : b.qualificado ? 'qualificado' : 'descartado',
    formulario: b.formulario, criadoEm: b.em_txt, convertido: b.pedidos > 0, pedidos: b.pedidos, valorCentavos: Number(b.valor),
  }
}

export type CursorContato = { em: string; id: string } | null
export interface PaginaContatos { itens: LinhaContato[]; proximoCursor: string | null }

/** Uma página (cursor por `criado_em DESC, id DESC`). `proximoCursor` null no fim. */
export async function listarContatos(
  tx: Sql, p: PeriodoResolvido, escopo: Escopo, filtros: FiltrosContatos, cursor: CursorContato, limite: number,
): Promise<PaginaContatos> {
  const linhas = await tx<Bruta[]>`
    WITH k AS (${coorteDetalhada(tx, p, escopo)})
    SELECT k.*, to_char(k.criado_em AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS em_txt
      FROM k
     WHERE ${condicoesFiltro(tx, filtros)}
       AND ${cursor === null ? tx`true` : tx`(k.criado_em, k.id) < (${cursor.em}::timestamptz, ${cursor.id}::uuid)`}
     ORDER BY k.criado_em DESC, k.id DESC
     LIMIT ${limite + 1}`
  const temMais = linhas.length > limite
  const pagina = temMais ? linhas.slice(0, limite) : linhas
  const ultimo = pagina[pagina.length - 1]
  return { itens: pagina.map(paraLinha), proximoCursor: temMais && ultimo ? montarCursor(ultimo.em_txt, ultimo.id) : null }
}

/**
 * Até `CSV_MAX_LINHAS` linhas juntadas de páginas por cursor (nunca uma consulta ilimitada: cada leitura
 * traz no máximo 250). `truncado` = havia mais que o teto. `abrir` roda cada lote numa transação curta.
 */
export async function coletarParaCsv(
  abrir: <T>(fn: (tx: Sql) => Promise<T>) => Promise<T>,
  leitura: (tx: Sql, cursor: CursorContato, limite: number) => Promise<PaginaContatos>,
): Promise<{ linhas: LinhaContato[]; truncado: boolean }> {
  const linhas: LinhaContato[] = []
  let cursor: CursorContato = null
  for (;;) {
    const faltam = CSV_MAX_LINHAS + 1 - linhas.length
    const lote = await abrir((tx) => leitura(tx, cursor, Math.min(LOTE_CSV, faltam)))
    linhas.push(...lote.itens)
    if (!lote.proximoCursor || linhas.length > CSV_MAX_LINHAS) break
    cursor = lerCursor(lote.proximoCursor)
  }
  const truncado = linhas.length > CSV_MAX_LINHAS
  return { linhas: truncado ? linhas.slice(0, CSV_MAX_LINHAS) : linhas, truncado }
}

const ROTULO_QUAL: Record<QualificacaoContato, string> = { novo: 'Novo', qualificado: 'Qualificado', descartado: 'Descartado' }

function celula(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v)
  if (/^[=+\-@\t\r]/.test(s) && !/^\+\d+$/.test(s)) s = `'${s}`
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** CSV pt-BR (BOM, `;`, CRLF). Valor em reais com vírgula; sem documento (só o TIPO de pessoa). */
export function contatosParaCsv(linhas: readonly LinhaContato[], fuso: string): string {
  const cab = ['Nome', 'Telefone', 'E-mail', 'Tipo de pessoa', 'UF', 'Cidade', 'Origem', 'Vendedor', 'Filial', 'Qualificação',
    'Formulário', 'Criado em', 'Convertido', 'Pedidos', 'Valor (R$)']
  const data = new Intl.DateTimeFormat('pt-BR', { timeZone: fuso, dateStyle: 'short', timeStyle: 'short' })
  const corpo = linhas.map((l) => [
    l.nome, l.telefone, l.email, l.tipoPessoa === null ? '' : l.tipoPessoa.toUpperCase(), l.uf, l.cidade, l.origem, l.vendedor,
    l.filial, ROTULO_QUAL[l.qualificacao], l.formulario, data.format(new Date(l.criadoEm)), l.convertido ? 'sim' : 'não',
    l.pedidos, (l.valorCentavos / 100).toFixed(2).replace('.', ','),
  ].map(celula).join(';'))
  return `﻿${[cab.map(celula).join(';'), ...corpo].map((l) => `${l}\r\n`).join('')}`
}

// ── Agregados sobre a coorte detalhada ───────────────────────────────────────────────────────────

export interface GrupoCoorte {
  readonly chave: string
  readonly rotulo: string
  readonly contatos: number
  readonly convertidos: number
  readonly taxa: number | null
  readonly valorCentavos: number
  /** fatia 0..1 dos contatos da coorte inteira (4 casas) */
  readonly percentual: number
}

export const TOP_GRUPOS = 20

/**
 * Agrupa a coorte (opcionalmente já filtrada por `filtro`) por (chave, rótulo) SQL — top N por contatos,
 * `truncado` quando houve corte. `juncao` entra depois de `FROM k` e pode referenciar `k.id`.
 * Empate desfeito pela chave em `COLLATE "C"`: a ordem não depende da collation do banco.
 */
export async function agruparCoorte(
  tx: Sql,
  def: { chave: Fragmento; rotulo: Fragmento; juncao?: Fragmento },
  totalCoorte: number, filtro?: Fragmento, top = TOP_GRUPOS,
): Promise<{ itens: GrupoCoorte[]; truncado: boolean }> {
  const linhas = await tx<{ chave: string; rotulo: string; contatos: number; convertidos: number; valor: string }[]>`
    WITH k AS (SELECT * FROM coorte_e3)
    SELECT ${def.chave} AS chave, min(${def.rotulo}) AS rotulo, count(*)::int AS contatos,
           count(*) FILTER (WHERE k.pedidos > 0)::int AS convertidos, coalesce(sum(k.valor), 0)::text AS valor
      FROM k ${def.juncao ?? tx``}
     WHERE ${filtro ?? tx`true`}
     GROUP BY 1
     ORDER BY count(*) DESC, ${def.chave} COLLATE "C"
     LIMIT ${top + 1}`
  const truncado = linhas.length > top
  return {
    truncado,
    itens: (truncado ? linhas.slice(0, top) : linhas).map((l) => ({
      chave: l.chave, rotulo: l.rotulo, contatos: l.contatos, convertidos: l.convertidos,
      taxa: taxaDe(l.convertidos, l.contatos), valorCentavos: Number(l.valor),
      percentual: totalCoorte > 0 ? Math.round((l.contatos / totalCoorte) * 10_000) / 10_000 : 0,
    })),
  }
}

/**
 * Materializa a coorte UMA vez por transação (tabela temporária que some no COMMIT) para os relatórios que
 * fazem várias agregações sobre ela. É privada da sessão/transação — nada vaza entre tenants. Chame antes de
 * `agruparCoorte` e de qualquer `WITH k AS (SELECT * FROM coorte_e3)`.
 */
export async function materializarCoorte(tx: Sql, p: PeriodoResolvido, escopo: Escopo): Promise<void> {
  await tx`DROP TABLE IF EXISTS pg_temp.coorte_e3`
  await tx`CREATE TEMP TABLE coorte_e3 ON COMMIT DROP AS ${coorteDetalhada(tx, p, escopo)}`
}
