import postgres from 'postgres'

/**
 * Database access.
 *
 * ⚠️ The pool connection is NEVER used directly by a request handler. Every
 * domain read/write goes through `comTenant()` (see plugins/tenant.ts), which
 * opens a transaction and sets the tenant for that transaction only.
 *
 * The reason is the whole point of ADR-001: `SET geracrm.tenant_id` on a pooled
 * connection would survive the request and leak into the next one — which could
 * be another company's. `SET LOCAL` inside a transaction cannot.
 */

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL não definida — veja .env.example')

export const sql = postgres(url, {
  max: Number(process.env.DB_POOL_MAX ?? 10),
  idle_timeout: 20,
  // ⚠️ Sem transform de nome: os nomes do domínio são em português e as colunas
  // são snake_case. Ligar camelCase aqui renomearia `qtd_vendas` para
  // `qtdVendas` em toda consulta crua — e o default do driver já é não
  // transformar, então declarar `transform: undefined` só quebrava o typecheck.
  onnotice: () => {},
})

/** Read-only replica. Heavy analytics must not compete with the inbox. */
export const sqlLeitura = process.env.DATABASE_REPLICA_URL
  ? postgres(process.env.DATABASE_REPLICA_URL, { max: 5, idle_timeout: 20, onnotice: () => {} })
  : sql

export type Sql = typeof sql

/**
 * Roda um callback numa transação já escopada a um tenant — para WORKERS e
 * WEBHOOKS, que têm um tenant conhecido mas NÃO uma requisição autenticada.
 *
 * ⚠️ Mesmo `SET LOCAL` do plugin de tenant: o valor morre com a transação, não
 * vaza para a próxima no pool. É o que deixa o webhook (sem JWT) escrever sob a
 * mesma RLS que o resto — o tenant vem da busca do canal, nunca de parâmetro.
 */
export async function comTenantServico<T>(tenantId: string, fn: (tx: Sql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('geracrm.tenant_id', ${tenantId}, true)`
    return fn(tx as unknown as Sql)
  }) as Promise<T>
}

/**
 * Roda um trecho ACESSÓRIO dentro de um SAVEPOINT, para que a falha dele não
 * derrube a transação inteira.
 *
 * ⚠️ **`try/catch` sozinho NÃO faz isso, e essa é a armadilha.** No Postgres, um
 * comando que falha aborta a transação INTEIRA: os comandos seguintes passam a
 * responder `current transaction is aborted` e o COMMIT vira ROLLBACK. O `catch`
 * engole o erro e dá a impressão de que foi tratado — o estrago aparece no fim,
 * no commit, longe de onde nasceu.
 *
 * É exatamente o risco de um passo secundário (confirmar pedido pela resposta,
 * atribuir origem de mídia) derrubar o passo PRINCIPAL: perder a mensagem do
 * cliente por causa de um dado acessório.
 *
 * ⚠️ Quem chama ainda precisa do `try/catch` — o savepoint isola o estrago, mas
 * o erro continua subindo. Isolar e engolir são decisões separadas.
 */
export async function emSavepoint<T>(tx: Sql, fn: (sp: Sql) => Promise<T>): Promise<T> {
  // O tipo público `Sql` é o do pool e não expõe `savepoint`; dentro de uma
  // transação do postgres.js ele existe. O elenco fica AQUI, num lugar só.
  const transacao = tx as unknown as {
    savepoint?: <R>(fn: (sp: Sql) => Promise<R>) => Promise<R>
  }
  if (!transacao.savepoint) {
    // Chamado fora de transação (teste com o pool): sem savepoint para criar, e
    // sem transação para proteger. Roda direto em vez de estourar.
    return fn(tx)
  }
  return transacao.savepoint((sp) => fn(sp))
}

export async function encerrarBanco(): Promise<void> {
  await sql.end({ timeout: 5 })
  if (sqlLeitura !== sql) await sqlLeitura.end({ timeout: 5 })
}
