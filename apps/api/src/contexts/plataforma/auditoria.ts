import { randomUUID } from 'node:crypto'
import type { Sql } from '../../db/index.js'

/**
 * Registro de auditoria (EP-07 / PLT-05). ⚠️ Quem fez o quê, quando — as ações
 * de governança (assumir, apagar, editar, transferir carteira…) deixam rastro.
 * `ator_id` NULL = ação do sistema.
 */
export async function auditar(
  tx: Sql,
  p: {
    atorId?: string | null
    acao: string
    entidade: string
    entidadeId?: string | null
    dados?: Record<string, unknown>
  },
): Promise<void> {
  await tx`
    INSERT INTO auditoria (tenant_id, id, ator_id, acao, entidade, entidade_id, dados)
    VALUES (tenant_atual(), ${randomUUID()}, ${p.atorId ?? null}, ${p.acao}, ${p.entidade},
            ${p.entidadeId ?? null}, ${JSON.stringify(p.dados ?? {})}::text::jsonb)`
}
