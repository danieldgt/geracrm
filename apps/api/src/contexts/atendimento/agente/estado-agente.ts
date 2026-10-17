import type { Sql } from '../../../db/index.js'

/**
 * ESTADO DO AGENTE ENTRE TURNOS — `agente_sessao.estado_agente` (0096).
 *
 * Uma chave por raia do pipeline (`perguntas`, `gatilhos`, `falha`…): cada
 * etapa lê e escreve SÓ a sua. É o que deixa uma raia guardar estado sem
 * migration própria e sem pisar na outra.
 *
 * ⚠️ Merge RASO por chave (`||` do jsonb): o patch `{perguntas: {...}}`
 *    substitui o valor inteiro de `perguntas` e preserva as demais chaves. Quem
 *    precisa acumular dentro da própria chave lê, junta e devolve o valor todo.
 * ⚠️ Nunca PII crua aqui: o estado aparece na auditoria da sessão.
 */
export type EstadoAgente = Readonly<Record<string, unknown>>

/** Estado da sessão; `{}` sem sessão ou sessão inexistente. Chamar sob tenant. */
export async function lerEstado(tx: Sql, sessaoId: string | null): Promise<EstadoAgente> {
  if (!sessaoId) return {}
  const [l] = await tx<{ estado_agente: unknown }[]>`
    SELECT estado_agente FROM agente_sessao WHERE tenant_id = tenant_atual() AND id = ${sessaoId}`
  const v = l?.estado_agente
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as EstadoAgente) : {}
}

/** Aplica um patch raso. Patch vazio não toca no banco. Chamar sob tenant. */
export async function patchEstado(tx: Sql, sessaoId: string | null, patch: EstadoAgente): Promise<void> {
  if (!sessaoId || Object.keys(patch).length === 0) return
  await tx`
    UPDATE agente_sessao SET estado_agente = estado_agente || ${JSON.stringify(patch)}::text::jsonb
     WHERE tenant_id = tenant_atual() AND id = ${sessaoId}`
}

/** Junta patches na ordem em que as etapas os devolveram (a última vence por chave). */
export function juntarPatches(patches: readonly (EstadoAgente | undefined)[]): EstadoAgente {
  return Object.assign({}, ...patches.filter(Boolean)) as EstadoAgente
}
