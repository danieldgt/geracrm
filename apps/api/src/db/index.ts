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
  // Domain names are in Portuguese; no camelCase transform.
  transform: undefined,
  onnotice: () => {},
})

/** Read-only replica. Heavy analytics must not compete with the inbox. */
export const sqlLeitura = process.env.DATABASE_REPLICA_URL
  ? postgres(process.env.DATABASE_REPLICA_URL, { max: 5, idle_timeout: 20, onnotice: () => {} })
  : sql

export type Sql = typeof sql

export async function encerrarBanco(): Promise<void> {
  await sql.end({ timeout: 5 })
  if (sqlLeitura !== sql) await sqlLeitura.end({ timeout: 5 })
}
