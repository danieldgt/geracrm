import { randomUUID } from 'node:crypto'
import {
  JANELA_RESUMO_OBJECOES_MAX, JANELA_RESUMO_OBJECOES_PADRAO, LIMITES_OBJECOES, percentualRevertida,
  type ResumoObjecaoDto,
} from '@geracrm/shared'
import type { Sql } from '../../../db/index.js'
import { mascararTexto } from './pipeline/tipos.js'

/**
 * OBJEÇÕES REGISTRADAS (raia G2) — a tabela de fatos `agente_objecao` (0126).
 *
 * Só RELATÓRIO: a entrega ao humano na 3ª objeção não revertida seguida é da
 * etapa `pipeline/objecoes-seguidas.ts`, sobre `agente_sessao.estado_agente`.
 * Chamar sempre sob tenant (RLS).
 */

export interface FatoObjecao {
  readonly canalId: string
  readonly conversaId: string
  readonly contatoId: string
  readonly sessaoId: string | null
  readonly codigo: string
  readonly objecao: string
  readonly revertida: boolean
  readonly observacao: string | null
  readonly agora: Date
}

export async function gravarObjecao(tx: Sql, f: FatoObjecao): Promise<string> {
  const id = randomUUID()
  const obs = f.observacao?.trim() ? mascararTexto(f.observacao.trim()).slice(0, LIMITES_OBJECOES.observacaoObjecao) : null
  await tx`
    INSERT INTO agente_objecao (tenant_id, id, canal_id, conversa_id, contato_id, sessao_id, codigo, objecao, revertida, observacao, criado_em)
    VALUES (tenant_atual(), ${id}, ${f.canalId}, ${f.conversaId}, ${f.contatoId}, ${f.sessaoId}, ${f.codigo},
            ${f.objecao.slice(0, LIMITES_OBJECOES.objecao)}, ${f.revertida}, ${obs}, ${f.agora})`
  return id
}

const MODOS_QUE_GRAVAM: ReadonlySet<string> = new Set(['autonomo', 'assistido'])

/**
 * Grava os fatos do turno CONFIRMADO (chamar de dentro da transação da decisão,
 * só no caminho que persiste o turno). Autônomo e assistido gravam; sombra,
 * simulação e copiloto não. Um fato por código no turno.
 */
export async function gravarObjecoesDoTurno(tx: Sql, p: {
  modo: string; canalId: string; conversaId: string; contatoId: string; sessaoId: string | null; agora: Date
  objecoes: readonly { codigo: string; revertida: boolean; objecao?: string | undefined; observacao?: string | null | undefined }[]
}): Promise<void> {
  if (!MODOS_QUE_GRAVAM.has(p.modo)) return
  const vistos = new Set<string>()
  for (const o of p.objecoes) {
    if (vistos.has(o.codigo)) continue
    vistos.add(o.codigo)
    await gravarObjecao(tx, {
      canalId: p.canalId, conversaId: p.conversaId, contatoId: p.contatoId, sessaoId: p.sessaoId,
      codigo: o.codigo, objecao: o.objecao ?? o.codigo, revertida: o.revertida, observacao: o.observacao ?? null, agora: p.agora,
    })
  }
}

/** Janela do resumo: inteiro 1–90; ausente/inválido = 30. */
export function janelaDoResumo(bruto: unknown): number {
  const n = Number(bruto)
  if (!Number.isInteger(n) || n < 1) return JANELA_RESUMO_OBJECOES_PADRAO
  return Math.min(n, JANELA_RESUMO_OBJECOES_MAX)
}

/**
 * Resumo por código na janela: vezes, revertidas e o texto da objeção da última
 * vez em que foi registrada. ⚠️ Agregado LIMITADO: códigos são OBJ-01…OBJ-99, então
 * no máximo 99 linhas (LIMIT 100 explícito) — não é lista de registros.
 */
export async function resumoDasObjecoes(tx: Sql, p: { dias: number; canalId: string | null; agora: Date }): Promise<ResumoObjecaoDto[]> {
  const desde = new Date(p.agora.getTime() - p.dias * 86_400_000)
  const linhas = await tx<{ codigo: string; objecao: string; vezes: number; revertidas: number }[]>`
    SELECT o.codigo,
           (array_agg(o.objecao ORDER BY o.criado_em DESC))[1] AS objecao,
           count(*)::int AS vezes,
           count(*) FILTER (WHERE o.revertida)::int AS revertidas
      FROM agente_objecao o
     WHERE o.tenant_id = tenant_atual() AND o.criado_em >= ${desde}
       ${p.canalId ? tx`AND o.canal_id = ${p.canalId}` : tx``}
     GROUP BY o.codigo
     ORDER BY count(*) DESC, o.codigo
     LIMIT 100`
  return linhas.map((l) => ({ ...l, percentualRevertida: percentualRevertida(l.vezes, l.revertidas) }))
}
