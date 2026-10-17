import type { EntradaPlayground, MarcaGuardrail } from '@geracrm/shared'
import { PLAYGROUND_MAX_ENTRADAS, VALIDADE_CONFERENCIA_DIAS } from '@geracrm/shared'
import type { Sql } from '../../../db/index.js'
import { avaliacaoDasMarcas } from './qualidade/avaliacao.js'

/**
 * CONFERÊNCIAS DE HOMOLOGAÇÃO (raia P19, migration 0109 `agente_homologacao`).
 *
 *   douradas / smoke — digitadas por admin no painel (POST /v1/agente/go-live/conferencia);
 *                      a tela mostra quem declarou e quando; vale 30 dias.
 *   playground       — UMA ENTRADA POR REINÍCIO da simulação, `{em, turnos, criticas}`,
 *                      contada das decisões que o próprio reinício apaga
 *                      (`DELETE … RETURNING guardrails`, atômico). A soma
 *                      (`somarPlayground`, shared) só usa as entradas dos últimos 30
 *                      dias DEPOIS do corte (`cortePlayground`) e só conta conversa
 *                      com ≥ 3 decisões.
 *
 * Uma linha por (tenant, número, item). Sob RLS do tenant, na transação de quem chama.
 */

const DIA_MS = 86_400_000

/** O usuário de quem pede, SEM criar a linha (o reinício do playground não é ação de governança). */
export async function atorSemCriar(tx: Sql, sub: string): Promise<string | null> {
  const [u] = await tx<{ id: string }[]>`SELECT id FROM usuario WHERE tenant_id = tenant_atual() AND cognito_sub = ${sub}`
  return u?.id ?? null
}

/** Decisão com CRÍTICA que escapou (não corrigida pelo pipeline), pela régua da P12. */
export function decisaoTemCritica(guardrails: unknown): boolean {
  const marcas = Array.isArray(guardrails) ? (guardrails as MarcaGuardrail[]) : []
  return avaliacaoDasMarcas(marcas).piorGravidade === 'CRITICA'
}

const ehEntrada = (v: unknown): v is EntradaPlayground =>
  !!v && typeof v === 'object' && typeof (v as EntradaPlayground).em === 'string'
  && Number.isFinite((v as EntradaPlayground).turnos) && Number.isFinite((v as EntradaPlayground).criticas)

/** As entradas guardadas do playground de um número. */
export async function entradasPlayground(tx: Sql, canalId: string): Promise<EntradaPlayground[]> {
  const [l] = await tx<{ resultado: { entradas?: unknown } }[]>`
    SELECT resultado FROM agente_homologacao WHERE tenant_id = tenant_atual() AND canal_id = ${canalId} AND item = 'playground'`
  return Array.isArray(l?.resultado.entradas) ? l.resultado.entradas.filter(ehEntrada) : []
}

/**
 * Registra UM reinício do playground a partir das decisões que o próprio
 * reinício apagou (`DELETE … RETURNING guardrails`): a contagem e a remoção são
 * a mesma operação, então dois "Reiniciar" simultâneos não contam a mesma
 * conversa duas vezes (o segundo apaga zero linhas e não registra nada).
 * Guarda só os últimos 30 dias, até `PLAYGROUND_MAX_ENTRADAS`.
 */
export async function registrarReinicioPlayground(
  tx: Sql, p: { readonly canalId: string; readonly apagadas: readonly { guardrails: unknown }[]; readonly atorId: string | null; readonly agora: Date },
): Promise<EntradaPlayground | null> {
  if (p.apagadas.length === 0) return null
  const nova: EntradaPlayground = {
    em: p.agora.toISOString(), turnos: p.apagadas.length,
    criticas: p.apagadas.filter((d) => decisaoTemCritica(d.guardrails)).length,
  }
  // Trava a linha: dois reinícios de conversas diferentes não se sobrescrevem.
  await tx`
    INSERT INTO agente_homologacao (tenant_id, canal_id, item, resultado, ator_id)
    VALUES (tenant_atual(), ${p.canalId}, 'playground', '{"entradas":[]}'::jsonb, ${p.atorId})
    ON CONFLICT (tenant_id, canal_id, item) DO NOTHING`
  const [l] = await tx<{ resultado: { entradas?: unknown } }[]>`
    SELECT resultado FROM agente_homologacao WHERE tenant_id = tenant_atual() AND canal_id = ${p.canalId} AND item = 'playground' FOR UPDATE`
  const limite = p.agora.getTime() - VALIDADE_CONFERENCIA_DIAS * DIA_MS
  const antigas = Array.isArray(l?.resultado.entradas) ? l.resultado.entradas.filter(ehEntrada) : []
  const entradas = [...antigas.filter((e) => Date.parse(e.em) >= limite), nova].slice(-PLAYGROUND_MAX_ENTRADAS)
  await tx`
    UPDATE agente_homologacao SET resultado = ${JSON.stringify({ entradas })}::text::jsonb, ator_id = ${p.atorId}, atualizado_em = ${p.agora}
     WHERE tenant_id = tenant_atual() AND canal_id = ${p.canalId} AND item = 'playground'`
  return nova
}

/**
 * O corte do playground: o mais recente entre a última PUBLICAÇÃO de playbook
 * que vale para o número (dele ou da conta) e a última mudança auditada da
 * configuração do número. Teste feito antes disso testou outra coisa.
 */
export async function cortePlayground(tx: Sql, canalId: string, agora: Date): Promise<Date | null> {
  const [r] = await tx<{ corte: Date | null }[]>`
    SELECT greatest(
      (SELECT max(publicada_em) FROM agente_playbook_versao
        WHERE tenant_id = tenant_atual() AND (canal_id = ${canalId} OR canal_id IS NULL) AND publicada_em <= ${agora}),
      (SELECT max(criado_em) FROM auditoria
        WHERE tenant_id = tenant_atual() AND entidade = 'agente_config' AND entidade_id = ${canalId}
          AND acao = 'agente.config_alterada' AND criado_em <= ${agora})) AS corte`
  return r?.corte ? new Date(r.corte) : null
}

export interface ConferenciaVigente {
  readonly resultado: Readonly<Record<string, unknown>>
  readonly atualizadoEm: Date
  /** Nome de quem declarou (null = sistema ou usuário removido). */
  readonly por: string | null
}

/** A conferência digitada vigente (atualizada nos últimos 30 dias); null sem conferência válida. */
export async function conferenciaVigente(tx: Sql, canalId: string, item: 'douradas' | 'smoke', agora: Date): Promise<ConferenciaVigente | null> {
  const [l] = await tx<{ resultado: Record<string, unknown>; atualizado_em: Date; por: string | null }[]>`
    SELECT h.resultado, h.atualizado_em, u.nome AS por
      FROM agente_homologacao h
      LEFT JOIN usuario u ON u.tenant_id = h.tenant_id AND u.id = h.ator_id
     WHERE h.tenant_id = tenant_atual() AND h.canal_id = ${canalId} AND h.item = ${item}
       AND h.atualizado_em >= ${new Date(agora.getTime() - VALIDADE_CONFERENCIA_DIAS * DIA_MS)}`
  return l ? { resultado: l.resultado, atualizadoEm: new Date(l.atualizado_em), por: l.por } : null
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
