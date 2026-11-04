import { resolverCanais, type CanaisLigados, type LinhaPreferencia } from '@geracrm/shared'
import type { Sql } from '../../db/index.js'

/**
 * Preferência de notificação por (usuário, tipo, canal) — D4.
 *
 * ⚠️ A regra (padrão do tipo + linhas gravadas) mora em `packages/shared`; aqui só se LÊ do banco, sob
 * RLS. Quem emite uma notificação pergunta aqui, ANTES de gravar, por onde cada destinatário quer
 * receber — e não grava o que ninguém quer receber.
 */
export async function canaisDosUsuarios(
  tx: Sql, usuarios: readonly string[], tipo: string,
): Promise<Map<string, CanaisLigados>> {
  const ids = [...new Set(usuarios)]
  const linhas = ids.length === 0 ? [] : await tx<(LinhaPreferencia & { usuario_id: string })[]>`
    SELECT usuario_id, tipo, canal, ligado
      FROM usuario_preferencia_notificacao
     WHERE tenant_id = tenant_atual() AND tipo = ${tipo} AND usuario_id = ANY(${ids}::uuid[])`
  const porUsuario = new Map<string, LinhaPreferencia[]>()
  for (const l of linhas) {
    const lista = porUsuario.get(l.usuario_id) ?? []
    lista.push(l)
    porUsuario.set(l.usuario_id, lista)
  }
  return new Map(ids.map((id) => [id, resolverCanais(tipo, porUsuario.get(id) ?? [])]))
}

/** Algum canal ligado? Se não, a notificação nem é gravada. */
export const algumCanal = (c: CanaisLigados): boolean => c.app || c.push || c.email
