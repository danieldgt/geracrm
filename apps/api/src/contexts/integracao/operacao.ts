import { randomUUID } from 'node:crypto'
import type { Sql } from '../../db/index.js'

/**
 * Registra uma operação de ingestão concluída (INT-08). ⚠️ `operacao_ingestao`
 * grava TUDO — a tela de sync (INT-08) e a reconciliação leem daqui. Sem isto,
 * "o que sincronizou e o que rejeitou" só existe no stdout do worker.
 *
 * Roda com a conexão de DONO (integrador), que ignora RLS — por isso o tenant
 * vai explícito.
 */
export async function registrarOperacao(
  sql: Sql,
  p: {
    tenantId: string
    conexaoId: string
    fluxo: 'customers' | 'products' | 'orders'
    origem?: 'sincronismo' | 'carga_historica' | 'manual'
    total: number
    aceitos: number
    rejeitados: number
    rejeicoes?: unknown[]
  },
): Promise<void> {
  await sql`
    INSERT INTO operacao_ingestao
      (tenant_id, id, conexao_id, fluxo, origem, total, aceitos, rejeitados, rejeicoes, estado, concluido_em)
    VALUES (${p.tenantId}, ${randomUUID()}, ${p.conexaoId}, ${p.fluxo}, ${p.origem ?? 'sincronismo'},
            ${p.total}, ${p.aceitos}, ${p.rejeitados},
            ${JSON.stringify((p.rejeicoes ?? []).slice(0, 100))}::text::jsonb, 'concluida', now())`
}
