import type { Sql } from '../../db/index.js'

/**
 * Filtros do board do funil (raia B1). Os mesmos valem para a coluna, para os totais das etapas e para o
 * panorama: o número do cabeçalho da coluna tem de ser o que a coluna mostra.
 *
 * ⚠️ Tudo é recorte ADICIONAL ao escopo (D3) e ao RLS — nunca o substitui. `tenant_id` vem do token.
 */
export interface FiltrosFunil {
  /** UUID do responsável ou 'sem-dono'. */
  vendedorId?: string
  filialId?: string
  etiquetaId?: string
  origemId?: string
  q?: string
}

export const SEM_DONO = 'sem-dono'
/** Valor de `filialId` para quem tem dono mas o dono não tem filial (cartão "Sem filial" do panorama). */
export const SEM_FILIAL = 'sem-filial'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const Q_MAX = 80

export type FiltrosLidos = { ok: true; filtros: FiltrosFunil } | { ok: false; campo: string }

/** Lê e valida os query params. Vazio = sem filtro; UUID malformado = erro (422), não "sem resultado". */
export function lerFiltrosFunil(query: Record<string, unknown>): FiltrosLidos {
  const filtros: FiltrosFunil = {}
  const txt = (k: string): string | undefined => {
    const v = query[k]
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
  }
  const vendedor = txt('vendedorId')
  if (vendedor !== undefined) {
    if (vendedor !== SEM_DONO && !UUID.test(vendedor)) return { ok: false, campo: 'vendedorId' }
    filtros.vendedorId = vendedor
  }
  const filial = txt('filialId')
  if (filial !== undefined) {
    if (filial !== SEM_FILIAL && !UUID.test(filial)) return { ok: false, campo: 'filialId' }
    filtros.filialId = filial
  }
  for (const k of ['etiquetaId', 'origemId'] as const) {
    const v = txt(k)
    if (v === undefined) continue
    if (!UUID.test(v)) return { ok: false, campo: k }
    filtros[k] = v
  }
  const q = txt('q')
  if (q !== undefined) filtros.q = q.slice(0, Q_MAX)
  return { ok: true, filtros }
}

/** Escapa `%`, `_` e `\` para o LIKE tratar a busca como texto literal. */
export function escaparLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/**
 * Fragmento SQL (AND-ável) dos filtros sobre `oportunidade` com o alias dado. Sem filtro = `true`.
 * Filial = filial do RESPONSÁVEL (`usuario_filial`), a mesma régua do escopo de filial.
 */
export function condicaoFiltrosFunil(tx: Sql, f: FiltrosFunil, alias = 'o') {
  const a = tx.unsafe(alias)
  const partes: ReturnType<Sql>[] = []
  if (f.vendedorId === SEM_DONO) partes.push(tx`${a}.responsavel_id IS NULL`)
  else if (f.vendedorId) partes.push(tx`${a}.responsavel_id = ${f.vendedorId}::uuid`)
  if (f.filialId === SEM_FILIAL) {
    partes.push(tx`(${a}.responsavel_id IS NOT NULL AND NOT EXISTS (
                      SELECT 1 FROM usuario_filial uf
                       WHERE uf.tenant_id = ${a}.tenant_id AND uf.usuario_id = ${a}.responsavel_id
                         AND uf.filial_id IS NOT NULL))`)
  } else if (f.filialId) {
    partes.push(tx`EXISTS (SELECT 1 FROM usuario_filial uf
                            WHERE uf.tenant_id = ${a}.tenant_id AND uf.usuario_id = ${a}.responsavel_id
                              AND uf.filial_id = ${f.filialId}::uuid)`)
  }
  if (f.etiquetaId) {
    partes.push(tx`EXISTS (SELECT 1 FROM contato_etiqueta ce
                            WHERE ce.tenant_id = ${a}.tenant_id AND ce.contato_id = ${a}.contato_id
                              AND ce.etiqueta_id = ${f.etiquetaId}::uuid)`)
  }
  if (f.origemId) {
    partes.push(tx`EXISTS (SELECT 1 FROM contato cf
                            WHERE cf.tenant_id = ${a}.tenant_id AND cf.id = ${a}.contato_id
                              AND cf.origem_id = ${f.origemId}::uuid)`)
  }
  if (f.q) {
    const like = `%${escaparLike(f.q)}%`
    const digitos = f.q.replace(/\D/g, '')
    const porTelefone = digitos.length >= 3
      ? tx`OR EXISTS (SELECT 1 FROM contato_telefone ct
                       WHERE ct.tenant_id = ${a}.tenant_id AND ct.contato_id = ${a}.contato_id
                         AND ct.e164 LIKE ${'%' + digitos + '%'})`
      : tx``
    partes.push(tx`(${a}.titulo ILIKE ${like}
                    OR EXISTS (SELECT 1 FROM contato cq
                                WHERE cq.tenant_id = ${a}.tenant_id AND cq.id = ${a}.contato_id
                                  AND cq.nome ILIKE ${like})
                    ${porTelefone})`)
  }
  if (partes.length === 0) return tx`true`
  return partes.reduce((acc, p, i) => (i === 0 ? p : tx`${acc} AND ${p}`))
}
