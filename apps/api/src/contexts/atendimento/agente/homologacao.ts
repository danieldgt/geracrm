import type { ItemHomologacao, MarcaGuardrail } from '@geracrm/shared'
import { VALIDADE_CONFERENCIA_DIAS } from '@geracrm/shared'
import type { Sql } from '../../../db/index.js'
import { avaliacaoDasMarcas } from './qualidade/avaliacao.js'

/**
 * CONFERÊNCIAS DE HOMOLOGAÇÃO (raia P19, migration 0109 `agente_homologacao`).
 *
 *   douradas / smoke — digitadas por admin no painel (POST /v1/agente/go-live/conferencia).
 *   playground       — ACUMULADO pelo sistema a cada reinício da simulação: antes
 *                      de apagar as decisões da conversa de teste, soma 1 conversa
 *                      e as decisões cuja pior gravidade que ESCAPOU é CRÍTICA
 *                      (régua da P12, `avaliacaoDasMarcas`).
 *
 * Uma linha por (tenant, número, item): a conferência VIGENTE. Linha sem
 * atualização há mais de 30 dias não vale (o painel ignora; o playground
 * recomeça a soma).
 * Sob RLS do tenant, na transação de quem chama.
 */

/** O usuário de quem pede, SEM criar a linha (o reinício do playground não é ação de governança). */
export async function atorSemCriar(tx: Sql, sub: string): Promise<string | null> {
  const [u] = await tx<{ id: string }[]>`SELECT id FROM usuario WHERE tenant_id = tenant_atual() AND cognito_sub = ${sub}`
  return u?.id ?? null
}

/** Decisão com CRÍTICA que escapou (não corrigida pelo pipeline). */
export function decisaoTemCritica(guardrails: unknown): boolean {
  const marcas = Array.isArray(guardrails) ? (guardrails as MarcaGuardrail[]) : []
  return avaliacaoDasMarcas(marcas).piorGravidade === 'CRITICA'
}

/**
 * Chamar ANTES de apagar as decisões da conversa de simulação (reinício do
 * playground). ⚠️ `FOR UPDATE` nas decisões: dois "Reiniciar" simultâneos não
 * contam a mesma conversa duas vezes — o segundo espera e já não acha nada.
 */
export async function acumularPlayground(tx: Sql, p: { readonly canalId: string; readonly conversaId: string; readonly atorId: string | null }): Promise<{ conversas: number; criticas: number } | null> {
  const ds = await tx<{ guardrails: unknown }[]>`
    SELECT guardrails FROM agente_decisao
     WHERE tenant_id = tenant_atual() AND conversa_id = ${p.conversaId} AND modo = 'simulacao'
     FOR UPDATE`
  if (ds.length === 0) return null
  const criticas = ds.filter((d) => decisaoTemCritica(d.guardrails)).length
  const novo = { conversas: 1, criticas, desde: new Date().toISOString() }
  const [l] = await tx<{ resultado: { conversas: number; criticas: number } }[]>`
    INSERT INTO agente_homologacao (tenant_id, canal_id, item, resultado, ator_id)
    VALUES (tenant_atual(), ${p.canalId}, 'playground', ${JSON.stringify(novo)}::text::jsonb, ${p.atorId})
    ON CONFLICT (tenant_id, canal_id, item) DO UPDATE SET
      resultado = CASE
        WHEN agente_homologacao.atualizado_em < now() - make_interval(days => ${VALIDADE_CONFERENCIA_DIAS}) THEN EXCLUDED.resultado
        ELSE jsonb_build_object(
          'conversas', coalesce((agente_homologacao.resultado->>'conversas')::int, 0) + 1,
          'criticas',  coalesce((agente_homologacao.resultado->>'criticas')::int, 0) + ${criticas}::int,
          'desde',     coalesce(agente_homologacao.resultado->'desde', EXCLUDED.resultado->'desde'))
      END,
      ator_id = EXCLUDED.ator_id, atualizado_em = now()
    RETURNING resultado`
  return { conversas: Number(l!.resultado.conversas), criticas: Number(l!.resultado.criticas) }
}

export interface ConferenciaVigente {
  readonly resultado: Readonly<Record<string, unknown>>
  readonly atualizadoEm: Date
}

/** A conferência vigente (atualizada nos últimos 30 dias) de um item; null sem conferência válida. */
export async function conferenciaVigente(tx: Sql, canalId: string, item: ItemHomologacao, agora: Date): Promise<ConferenciaVigente | null> {
  const [l] = await tx<{ resultado: Record<string, unknown>; atualizado_em: Date }[]>`
    SELECT resultado, atualizado_em FROM agente_homologacao
     WHERE tenant_id = tenant_atual() AND canal_id = ${canalId} AND item = ${item}
       AND atualizado_em >= ${new Date(agora.getTime() - VALIDADE_CONFERENCIA_DIAS * 86_400_000)}`
  return l ? { resultado: l.resultado, atualizadoEm: new Date(l.atualizado_em) } : null
}

/** Grava (substitui) a conferência digitada; devolve a anterior para a auditoria. */
export async function gravarConferencia(
  tx: Sql, p: { readonly canalId: string; readonly item: 'douradas' | 'smoke'; readonly resultado: Readonly<Record<string, unknown>>; readonly atorId: string | null },
): Promise<{ antes: Record<string, unknown> | null; atualizadoEm: Date }> {
  const [a] = await tx<{ resultado: Record<string, unknown> }[]>`
    SELECT resultado FROM agente_homologacao WHERE tenant_id = tenant_atual() AND canal_id = ${p.canalId} AND item = ${p.item} FOR UPDATE`
  const [l] = await tx<{ atualizado_em: Date }[]>`
    INSERT INTO agente_homologacao (tenant_id, canal_id, item, resultado, ator_id)
    VALUES (tenant_atual(), ${p.canalId}, ${p.item}, ${JSON.stringify(p.resultado)}::text::jsonb, ${p.atorId})
    ON CONFLICT (tenant_id, canal_id, item) DO UPDATE SET
      resultado = EXCLUDED.resultado, ator_id = EXCLUDED.ator_id, atualizado_em = now()
    RETURNING atualizado_em`
  return { antes: a?.resultado ?? null, atualizadoEm: new Date(l!.atualizado_em) }
}
