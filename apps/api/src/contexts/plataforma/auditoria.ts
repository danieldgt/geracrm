import { randomUUID } from 'node:crypto'
import type { Sql } from '../../db/index.js'

/**
 * Registro de auditoria (EP-07 / PLT-05). ⚠️ Quem fez o quê, quando — as ações
 * de governança (assumir, apagar, editar, transferir carteira…) deixam rastro.
 * `ator_id` NULL = ação do sistema.
 *
 * ⚠️ `atorStaff` marca a ação feita por alguém do drezz dentro do cliente. A
 * coluna e o índice parcial `auditoria_staff` nasceram na migration 0004 para
 * responder "o que a Gera3 viu deste cliente?" e ficaram sem escritor até aqui —
 * sem essa marca, a ação do staff se confunde com a do próprio cliente na
 * trilha, que é justamente o que ninguém quer na hora de auditar.
 */
export async function auditar(
  tx: Sql,
  p: {
    atorId?: string | null
    acao: string
    entidade: string
    entidadeId?: string | null
    dados?: Record<string, unknown>
    atorStaff?: boolean
  },
): Promise<void> {
  await tx`
    INSERT INTO auditoria (tenant_id, id, ator_id, ator_staff, acao, entidade, entidade_id, dados)
    VALUES (tenant_atual(), ${randomUUID()}, ${p.atorId ?? null}, ${p.atorStaff ?? false},
            ${p.acao}, ${p.entidade},
            ${p.entidadeId ?? null}, ${JSON.stringify(p.dados ?? {})}::text::jsonb)`
}
