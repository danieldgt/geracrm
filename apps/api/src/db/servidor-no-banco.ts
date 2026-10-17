import type { Sql } from './index.js'

/**
 * `application_name` das conexões DONO dos WORKERS do servidor (`server.ts`). Os workers
 * (agente, pós-ingestão, retornos, qualidade, vigias…) varrem a fila de TODOS os tenants.
 */
export const APLICACAO_WORKERS = 'geracrm-workers'

/**
 * ⚠️ CAUSA DE TESTE INSTÁVEL (P0d, reproduzida): um servidor (`pnpm dev`, ou um `tsx watch`
 * órfão de outro worktree) ligado no MESMO banco da suíte consome as filas dos testes — o
 * worker do agente pega a `agente_tarefa` de `fila.test.ts` e o de pós-ingestão executa a
 * `tarefa_pos_ingestao` de `webhook-enxuto.test.ts` antes do teste. Isolar por tenant não
 * adianta: o servidor roda como dono, sem tenant. Com um "servidor intruso" rodando, 5 de 6
 * rodadas desses dois arquivos falharam; sem ele, nenhuma.
 *
 * Devolve quantas conexões de workers de servidor estão no banco atual (o globalSetup do
 * vitest recusa rodar a suíte com alguma, dizendo o porquê, em vez de falhar ao acaso).
 */
export async function conexoesDeWorkersNoBanco(dono: Sql): Promise<number> {
  const [r] = await dono<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_stat_activity
     WHERE datname = current_database() AND application_name = ${APLICACAO_WORKERS} AND pid <> pg_backend_pid()`
  return r?.n ?? 0
}

export function mensagemServidorNoBanco(n: number, banco: string): string {
  return `Há ${n} conexão(ões) de workers de um servidor GeraCRM (application_name=${APLICACAO_WORKERS}) no banco "${banco}". `
    + 'Os workers dele consomem as filas dos testes (agente_tarefa, tarefa_pos_ingestao…) e a suíte falha ao acaso. '
    + 'Pare o servidor (pnpm dev / tsx watch) ou rode os testes num banco próprio (DATABASE_URL/DATABASE_ADMIN_URL).'
}
