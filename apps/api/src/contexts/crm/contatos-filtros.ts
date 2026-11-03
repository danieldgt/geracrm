import { z } from 'zod'
import { faixasDoSegmento, ehCodigoSegmentoRfv, ehQualificacaoContato, MAX_ETIQUETAS_NO_FILTRO, VENDEDOR_SEM_DONO, type CodigoSegmentoRfv, type FaixaRfv, type QualificacaoContato } from '@geracrm/shared'
import type { Sql } from '../../db/index.js'
import { fusoSeguro } from '../plataforma/fuso.js'
import { moduloAtivo } from '../plataforma/modulos.js'

/**
 * Filtros da lista de contatos (A2). Todos opcionais, combinados com AND, sobre o
 * mesmo `FROM contato c LEFT JOIN metricas_contato m` de `GET /v1/contatos` —
 * o escopo da D3 (`condicaoContato`) e o cursor continuam sendo aplicados pela
 * rota; aqui só se acrescenta restrição.
 *
 * ⚠️ Tudo vira SQL: nenhum filtro lê a base para filtrar em memória. "Sem próximo
 *    passo" é a regra de `semProximoPasso` (shared) escrita como NOT EXISTS, o
 *    mesmo critério de `/v1/tarefas/sem-proximo-passo`, sem N+1.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DIA = /^\d{4}-\d{2}-\d{2}$/

function diaReal(v: string): boolean {
  if (!DIA.test(v)) return false
  const [a, m, d] = v.split('-').map(Number) as [number, number, number]
  const dt = new Date(Date.UTC(a, m - 1, d))
  return dt.getUTCFullYear() === a && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

const uuid = z.string().regex(UUID)
const lista = (v: unknown) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])

const esquema = z.object({
  q: z.string().trim().max(120).optional(),
  qualificacao: z.string().refine(ehQualificacaoContato).optional(),
  segmento: z.string().refine(ehCodigoSegmentoRfv).optional(),
  vendedorId: z.union([uuid, z.literal(VENDEDOR_SEM_DONO)]).optional(),
  filialId: uuid.optional(),
  origemId: uuid.optional(),
  etiquetaId: z.preprocess(lista, z.array(uuid).max(MAX_ETIQUETAS_NO_FILTRO)).optional(),
  semProximoPasso: z.enum(['true', 'false']).optional(),
  carteiraAtiva: z.enum(['true', 'false']).optional(),
  criadoDe: z.string().refine(diaReal).optional(),
  criadoAte: z.string().refine(diaReal).optional(),
})

export interface FiltrosContato {
  readonly q: string | null
  readonly qualificacao: QualificacaoContato | null
  readonly segmento: CodigoSegmentoRfv | null
  readonly vendedorId: string | null
  readonly filialId: string | null
  readonly origemId: string | null
  readonly etiquetaIds: readonly string[]
  readonly semProximoPasso: boolean
  /** Carteira ATIVA (D2): qualificado OU com oportunidade aberta — o denominador do indicador de próximo passo. */
  readonly carteiraAtiva: boolean
  readonly criadoDe: string | null
  readonly criadoAte: string | null
}

export type ResultadoFiltros =
  | { readonly ok: true; readonly filtros: FiltrosContato }
  | { readonly ok: false; readonly campos: string[] }

/** Valida a querystring. Valor inválido → 422 com os campos (nunca ignora em silêncio). */
export function lerFiltros(query: unknown): ResultadoFiltros {
  const p = esquema.safeParse(query ?? {})
  if (!p.success) return { ok: false, campos: [...new Set(p.error.issues.map((i) => String(i.path[0] ?? '')).filter(Boolean))] }
  const d = p.data
  if (d.criadoDe && d.criadoAte && d.criadoDe > d.criadoAte) return { ok: false, campos: ['criadoDe', 'criadoAte'] }
  return {
    ok: true,
    filtros: {
      q: d.q ? d.q : null,
      qualificacao: (d.qualificacao as QualificacaoContato | undefined) ?? null,
      segmento: (d.segmento as CodigoSegmentoRfv | undefined) ?? null,
      vendedorId: d.vendedorId ?? null,
      filialId: d.filialId ?? null,
      origemId: d.origemId ?? null,
      etiquetaIds: [...new Set((d.etiquetaId ?? []).map((e) => e.toLowerCase()))],
      semProximoPasso: d.semProximoPasso === 'true',
      carteiraAtiva: d.carteiraAtiva === 'true',
      criadoDe: d.criadoDe ?? null,
      criadoAte: d.criadoAte ?? null,
    },
  }
}

/**
 * Filial EFETIVA do contato (alias `c`): a gravada nele ou, na falta, a do dono vigente da carteira
 * (a primeira filial dele, por id). É a mesma régua do cockpit (D1) e do indicador da D2 — clicar numa
 * filial do indicador e filtrar a lista dão o mesmo recorte.
 */
export function filialEfetivaDoContato(tx: Sql, aliasContato = 'c') {
  const a = tx.unsafe(aliasContato)
  return tx`coalesce(${a}.filial_id, (
    SELECT fef.filial_id FROM carteira_atribuicao fea
      JOIN usuario_filial fef ON fef.tenant_id = fea.tenant_id AND fef.usuario_id = fea.usuario_id AND fef.filial_id IS NOT NULL
     WHERE fea.tenant_id = ${a}.tenant_id AND fea.contato_id = ${a}.id AND fea.ate IS NULL AND fea.usuario_id IS NOT NULL
     ORDER BY fef.filial_id LIMIT 1))`
}

/** Carteira ativa: qualificado OU oportunidade aberta (alias `c`). */
export function condicaoCarteiraAtiva(tx: Sql, aliasContato = 'c') {
  const a = tx.unsafe(aliasContato)
  return tx`(${a}.qualificado IS TRUE OR EXISTS (
    SELECT 1 FROM oportunidade fop WHERE fop.tenant_id = ${a}.tenant_id AND fop.contato_id = ${a}.id AND fop.estado = 'aberta'))`
}

const escaparLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`)

/** Uma faixa de segmento como condição sobre `m` (métricas). */
export function condicaoSegmentoDaFaixa(tx: Sql, f: FaixaRfv) {
  if (f.tipo === 'sem_ritmo_recente') {
    return tx`(m.atraso_relativo IS NULL AND m.dias_sem_comprar IS NOT NULL AND m.dias_sem_comprar <= ${f.diasAte})`
  }
  if (f.tipo === 'sem_ritmo_parado') {
    return tx`(m.atraso_relativo IS NULL AND (m.dias_sem_comprar IS NULL OR m.dias_sem_comprar > ${f.diasApos}))`
  }
  return tx`(m.atraso_relativo IS NOT NULL
             AND ${f.apos === null ? tx`true` : tx`m.atraso_relativo > ${f.apos}`}
             AND ${f.ate === null ? tx`true` : tx`m.atraso_relativo <= ${f.ate}`})`
}

/** Segmento como condição sobre `m` (métricas): as fronteiras saem de `faixasDoSegmento`. */
function condicaoSegmento(tx: Sql, codigo: CodigoSegmentoRfv) {
  const partes = faixasDoSegmento(codigo).map((f) => condicaoSegmentoDaFaixa(tx, f))
  return partes.reduce((acc, p, i) => (i === 0 ? p : tx`${acc} OR ${p}`), tx`false`)
}

/** O contexto que depende de leitura: fuso do tenant (período) e módulo Agenda (regra do "sem próximo passo"). */
export async function contextoDosFiltros(tx: Sql, f: FiltrosContato): Promise<{ fuso: string; agenda: boolean }> {
  const fuso = f.criadoDe || f.criadoAte
    ? fusoSeguro((await tx<{ fuso: string | null }[]>`SELECT fuso FROM tenant WHERE id = tenant_atual()`)[0]?.fuso)
    : 'America/Sao_Paulo'
  const agenda = await moduloAtivo(tx, 'agenda')
  return { fuso, agenda }
}

/** Condição SQL única (AND) dos filtros sobre os aliases `c` (contato) e `m` (métricas). */
export function condicaoFiltros(tx: Sql, f: FiltrosContato, ctx: { fuso: string; agenda: boolean }) {
  const q = f.q
  const digitos = q ? q.replace(/\D/g, '') : ''
  const busca = q === null ? tx`true` : tx`(
    c.nome ILIKE ${'%' + escaparLike(q) + '%'}
    OR c.razao_social ILIKE ${'%' + escaparLike(q) + '%'}
    OR c.nome_fantasia ILIKE ${'%' + escaparLike(q) + '%'}
    OR c.email ILIKE ${'%' + escaparLike(q) + '%'}
    ${digitos.length >= 4 ? tx`
    OR EXISTS (SELECT 1 FROM contato_telefone ft WHERE ft.tenant_id = c.tenant_id AND ft.contato_id = c.id
                  AND ft.e164 LIKE ${'%' + digitos + '%'})
    OR EXISTS (SELECT 1 FROM contato_documento fd WHERE fd.tenant_id = c.tenant_id AND fd.contato_id = c.id
                  AND fd.numero LIKE ${digitos + '%'})` : tx``})`

  const qualificacao = f.qualificacao === null ? tx`true`
    : f.qualificacao === 'novo' ? tx`c.qualificado IS NULL`
    : f.qualificacao === 'qualificado' ? tx`c.qualificado IS TRUE`
    : tx`c.qualificado IS FALSE`

  const vendedor = f.vendedorId === null ? tx`true`
    : f.vendedorId === VENDEDOR_SEM_DONO
      ? tx`NOT EXISTS (SELECT 1 FROM carteira_atribuicao fca WHERE fca.tenant_id = c.tenant_id AND fca.contato_id = c.id
                          AND fca.ate IS NULL AND fca.usuario_id IS NOT NULL)`
      : tx`EXISTS (SELECT 1 FROM carteira_atribuicao fca WHERE fca.tenant_id = c.tenant_id AND fca.contato_id = c.id
                      AND fca.ate IS NULL AND fca.usuario_id = ${f.vendedorId}::uuid)`

  // Um EXISTS por etiqueta (contém TODAS): vira semi-join por hash. O `count(*) = n` correlacionado
  // fazia 637 ms em 60 mil contatos (EXPLAIN); o EXISTS, 34 ms.
  const etiquetas = f.etiquetaIds.reduce(
    (acc, id) => tx`${acc} AND EXISTS (SELECT 1 FROM contato_etiqueta fce WHERE fce.tenant_id = c.tenant_id
                     AND fce.contato_id = c.id AND fce.etiqueta_id = ${id}::uuid)`,
    tx`true`)

  const semPasso = !f.semProximoPasso ? tx`true` : tx`(
    NOT EXISTS (SELECT 1 FROM tarefa ft WHERE ft.tenant_id = c.tenant_id AND ft.contato_id = c.id
                   AND ft.estado = 'aberta' AND ft.vence_em >= now())
    ${ctx.agenda ? tx`AND NOT EXISTS (SELECT 1 FROM evento_agenda fe WHERE fe.tenant_id = c.tenant_id AND fe.contato_id = c.id
                   AND fe.status = 'agendado' AND fe.inicio >= now())` : tx``})`

  return tx`(
    ${busca}
    AND ${qualificacao}
    AND ${f.segmento === null ? tx`true` : tx`(${condicaoSegmento(tx, f.segmento)})`}
    AND ${vendedor}
    AND ${f.filialId === null ? tx`true` : tx`${filialEfetivaDoContato(tx, 'c')} = ${f.filialId}::uuid`}
    AND ${f.origemId === null ? tx`true` : tx`c.origem_id = ${f.origemId}::uuid`}
    AND ${etiquetas}
    AND ${semPasso}
    AND ${f.carteiraAtiva ? condicaoCarteiraAtiva(tx, 'c') : tx`true`}
    AND ${f.criadoDe === null ? tx`true` : tx`c.criado_em >= (${f.criadoDe}::date)::timestamp AT TIME ZONE ${ctx.fuso}::text`}
    AND ${f.criadoAte === null ? tx`true` : tx`c.criado_em < ((${f.criadoAte}::date + 1))::timestamp AT TIME ZONE ${ctx.fuso}::text`}
  )`
}
