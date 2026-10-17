import type { Sql } from '../../../../db/index.js'
import type { TipoDocumento } from './porta.js'

/**
 * HISTÓRICO IMUTÁVEL das versões do conhecimento (raia P9, ADR-033, migration 0100).
 *
 * Cada versão de `conhecimento_documento` tem uma linha em
 * `conhecimento_documento_versao` com o TEXTO EXATO daquela versão. É o que faz
 * "Frete v3", citado numa decisão do agente, abrir o texto que o agente leu —
 * e não o de hoje.
 *
 * ⚠️ Toda escrita que sobe a versão chama `registrarVersao` NA MESMA TRANSAÇÃO,
 *    com os valores devolvidos pelo próprio UPDATE/INSERT (RETURNING) — nunca
 *    com uma leitura anterior, que pode estar velha sob concorrência.
 * ⚠️ Rede de segurança no banco: um trigger deferido grava, no commit, a versão
 *    que ficou sem linha (origem 'automatica'). Aqui o INSERT é idempotente
 *    (`ON CONFLICT DO NOTHING`) pelo mesmo motivo.
 */

export const ORIGENS_VERSAO = ['criacao', 'edicao', 'restauracao', 'sincronismo', 'backfill', 'automatica'] as const
export type OrigemVersao = (typeof ORIGENS_VERSAO)[number]

/** Página do histórico: 20 por vez, por cursor (número da versão). */
export const PAGINA_VERSOES = 20
export const MAX_OBSERVACAO = 280

/** O que o UPDATE/INSERT do documento devolveu — a versão como ela ficou gravada. */
export interface SnapshotDocumento {
  readonly id: string
  readonly versao: number
  readonly titulo: string
  readonly tipo: TipoDocumento
  readonly canal_id: string | null
  readonly conteudo: string
}

export interface MetaVersao {
  readonly origem: Exclude<OrigemVersao, 'backfill' | 'automatica'>
  readonly autorId?: string | null
  readonly autorStaff?: boolean
  readonly observacao?: string | null
  readonly restauradaDe?: number | null
}

export async function registrarVersao(tx: Sql, doc: SnapshotDocumento, meta: MetaVersao): Promise<void> {
  await tx`
    INSERT INTO conhecimento_documento_versao
      (tenant_id, documento_id, versao, titulo, tipo, canal_id, conteudo, origem, restaurada_de, observacao, autor_id, autor_staff)
    VALUES (tenant_atual(), ${doc.id}, ${doc.versao}, ${doc.titulo}, ${doc.tipo}, ${doc.canal_id}, ${doc.conteudo},
            ${meta.origem}, ${meta.restauradaDe ?? null}, ${meta.observacao ?? null}, ${meta.autorId ?? null}, ${meta.autorStaff ?? false})
    ON CONFLICT (tenant_id, documento_id, versao) DO NOTHING`
}

interface LinhaVersao {
  versao: number; titulo: string; tipo: string; canal_id: string | null; caracteres: number
  origem: OrigemVersao; restaurada_de: number | null; observacao: string | null
  autor_id: string | null; autor_nome: string | null; autor_staff: boolean; criado_em: Date
}

export interface ItemVersao {
  readonly versao: number
  readonly titulo: string
  readonly tipo: string
  readonly canalId: string | null
  readonly caracteres: number
  readonly origem: OrigemVersao
  readonly restauradaDe: number | null
  readonly observacao: string | null
  readonly autor: { readonly id: string; readonly nome: string | null } | null
  readonly autorStaff: boolean
  readonly criadoEm: Date
  /** É a versão em vigor do documento? */
  readonly atual: boolean
}

function paraItem(l: LinhaVersao, versaoAtual: number): ItemVersao {
  return {
    versao: l.versao, titulo: l.titulo, tipo: l.tipo, canalId: l.canal_id, caracteres: l.caracteres,
    origem: l.origem, restauradaDe: l.restaurada_de, observacao: l.observacao,
    autor: l.autor_id ? { id: l.autor_id, nome: l.autor_nome } : null, autorStaff: l.autor_staff,
    criadoEm: l.criado_em, atual: l.versao === versaoAtual,
  }
}

export type ResultadoListarVersoes =
  | { readonly ok: true; readonly versaoAtual: number; readonly itens: readonly ItemVersao[]; readonly proximoCursor: string | null }
  | { readonly ok: false; readonly erro: 'nao_encontrado' }

/** Histórico do documento, da mais nova para a mais velha. `antesDe` = cursor (exclusivo). */
export async function listarVersoes(tx: Sql, documentoId: string, antesDe: number | null): Promise<ResultadoListarVersoes> {
  const [doc] = await tx<{ versao: number }[]>`
    SELECT versao FROM conhecimento_documento WHERE tenant_id = tenant_atual() AND id = ${documentoId}`
  if (!doc) return { ok: false, erro: 'nao_encontrado' }
  const linhas = await tx<LinhaVersao[]>`
    SELECT v.versao, v.titulo, v.tipo, v.canal_id, length(v.conteudo)::int AS caracteres, v.origem, v.restaurada_de,
           v.observacao, v.autor_id, u.nome AS autor_nome, v.autor_staff, v.criado_em
      FROM conhecimento_documento_versao v
      LEFT JOIN usuario u ON u.tenant_id = v.tenant_id AND u.id = v.autor_id
     WHERE v.tenant_id = tenant_atual() AND v.documento_id = ${documentoId}
       AND ${antesDe === null ? tx`true` : tx`v.versao < ${antesDe}`}
     ORDER BY v.versao DESC LIMIT ${PAGINA_VERSOES + 1}`
  const temMais = linhas.length > PAGINA_VERSOES
  const pagina = temMais ? linhas.slice(0, PAGINA_VERSOES) : linhas
  const ultimo = pagina[pagina.length - 1]
  return {
    ok: true, versaoAtual: doc.versao,
    itens: pagina.map((l) => paraItem(l, doc.versao)),
    proximoCursor: temMais && ultimo ? String(ultimo.versao) : null,
  }
}

export interface VersaoCompleta extends ItemVersao {
  readonly documentoId: string
  readonly conteudo: string
  readonly versaoAtual: number
}

export type ResultadoLerVersao =
  | { readonly ok: true; readonly versao: VersaoCompleta }
  | { readonly ok: false; readonly erro: 'nao_encontrado' | 'versao_nao_encontrada' | 'versao_anterior_ao_historico'; readonly primeiraRegistrada?: number }

/**
 * O texto exato da versão N. Versão que existiu (N ≤ atual) mas não tem linha
 * é anterior ao histórico (sobrescrita antes da 0100) — falha NOMEADA, nunca o
 * texto de outra versão no lugar.
 */
export async function lerVersao(tx: Sql, documentoId: string, versao: number): Promise<ResultadoLerVersao> {
  const [doc] = await tx<{ versao: number }[]>`
    SELECT versao FROM conhecimento_documento WHERE tenant_id = tenant_atual() AND id = ${documentoId}`
  if (!doc) return { ok: false, erro: 'nao_encontrado' }
  const [l] = await tx<(LinhaVersao & { conteudo: string })[]>`
    SELECT v.versao, v.titulo, v.tipo, v.canal_id, v.conteudo, length(v.conteudo)::int AS caracteres, v.origem,
           v.restaurada_de, v.observacao, v.autor_id, u.nome AS autor_nome, v.autor_staff, v.criado_em
      FROM conhecimento_documento_versao v
      LEFT JOIN usuario u ON u.tenant_id = v.tenant_id AND u.id = v.autor_id
     WHERE v.tenant_id = tenant_atual() AND v.documento_id = ${documentoId} AND v.versao = ${versao}`
  if (l) return { ok: true, versao: { ...paraItem(l, doc.versao), documentoId, conteudo: l.conteudo, versaoAtual: doc.versao } }
  if (versao > doc.versao) return { ok: false, erro: 'versao_nao_encontrada' }
  const [p] = await tx<{ primeira: number | null }[]>`
    SELECT min(versao)::int AS primeira FROM conhecimento_documento_versao
     WHERE tenant_id = tenant_atual() AND documento_id = ${documentoId}`
  return { ok: false, erro: 'versao_anterior_ao_historico', ...(p?.primeira ? { primeiraRegistrada: p.primeira } : {}) }
}
