import { describe, it, expect, afterAll } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import postgres from 'postgres'

/**
 * Varredores de schema (E1-08 / plano-onda-0 §5.6) — invariantes que os testes
 * de unidade não pegam, verificados contra o schema REAL. Cada `it` que falha
 * derruba o CI. "Invariante protegida por disciplina é invariante violada."
 *
 * São 9 (os 8 do §5.6 + o Numeração da revisão-final §3.1).
 */
const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

/** ⚠️ Lista FECHADA das tabelas globais sem tenant_id (§7.2). Crescer aqui é
 *  decisão consciente — o varredor Tenancy falha para qualquer outra. */
const EXCECOES_TENANCY = new Set([
  'tenant', 'plano', 'perfil_vertical_modelo', 'tarifa_meta', 'schema_migrations',
])

const aqui = dirname(fileURLToPath(import.meta.url))
const RAIZ = resolve(aqui, '../../../..')
const DIR_MIGRATIONS = resolve(RAIZ, 'infra/migrations')

afterAll(async () => { await dono.end() })

describe('Varredor: Tenancy (tenant_id + RLS FORCE + WITH CHECK)', () => {
  it('toda tabela de domínio tem tenant_id', async () => {
    const faltando = await dono<{ tablename: string }[]>`
      SELECT t.tablename FROM pg_tables t
       WHERE t.schemaname = 'public'
         AND NOT EXISTS (
           SELECT 1 FROM information_schema.columns c
            WHERE c.table_schema = 'public' AND c.table_name = t.tablename AND c.column_name = 'tenant_id')
       ORDER BY 1`
    const violacoes = faltando.map((r) => r.tablename).filter((n) => !EXCECOES_TENANCY.has(n))
    expect(violacoes, `tabelas de domínio sem tenant_id: ${violacoes.join(', ')}`).toEqual([])
  })

  it('toda tabela de domínio tem RLS FORCE', async () => {
    const semForce = await dono<{ relname: string }[]>`
      SELECT c.relname FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      WHERE c.relkind IN ('r','p')
        AND NOT c.relispartition  -- ⚠️ filhas herdam a RLS do pai particionado
        AND EXISTS (SELECT 1 FROM information_schema.columns col
                     WHERE col.table_schema='public' AND col.table_name=c.relname AND col.column_name='tenant_id')
        AND NOT c.relforcerowsecurity
      ORDER BY 1`
    const violacoes = semForce.map((r) => r.relname)
    expect(violacoes, `tabelas com tenant_id sem RLS FORCE: ${violacoes.join(', ')}`).toEqual([])
  })

  it('toda policy de escrita (INSERT/UPDATE/ALL) tem WITH CHECK', async () => {
    const semCheck = await dono<{ tablename: string; policyname: string; cmd: string }[]>`
      SELECT tablename, policyname, cmd FROM pg_policies
       WHERE schemaname = 'public' AND cmd IN ('INSERT','UPDATE','ALL') AND with_check IS NULL
       ORDER BY 1,2`
    const violacoes = semCheck.map((r) => `${r.tablename}.${r.policyname}(${r.cmd})`)
    expect(violacoes, `policies de escrita sem WITH CHECK: ${violacoes.join(', ')}`).toEqual([])
  })
})

describe('Varredor: INV-46 (colunas _centavos são bigint)', () => {
  // ⚠️ Exceção consciente: tarifa da Meta é FRACIONÁRIA (sub-centavo), então
  //    tarifa_meta.valor_centavos é numeric(12,4) de propósito.
  const EXCECOES_CENTAVOS = new Set(['tarifa_meta.valor_centavos'])

  it('nenhuma coluna *_centavos de tabela-base fora de bigint', async () => {
    // Só tabelas-base (r/p) — matviews de métrica agregam com AVG/SUM (numeric).
    const erradas = await dono<{ table_name: string; column_name: string; data_type: string }[]>`
      SELECT col.table_name, col.column_name, col.data_type
        FROM information_schema.columns col
        JOIN pg_class c ON c.relname = col.table_name AND c.relnamespace = 'public'::regnamespace
       WHERE col.table_schema = 'public' AND c.relkind IN ('r','p')
         AND col.column_name LIKE '%\\_centavos' AND col.data_type <> 'bigint'
       ORDER BY 1,2`
    const violacoes = erradas
      .map((r) => `${r.table_name}.${r.column_name}`)
      .filter((k) => !EXCECOES_CENTAVOS.has(k))
    expect(violacoes, `colunas _centavos não-bigint: ${violacoes.join(', ')}`).toEqual([])
  })
})

describe('Varredor: INV-48 (sem enum no banco)', () => {
  it('não existe tipo enum', async () => {
    const enums = await dono<{ typname: string }[]>`
      SELECT t.typname FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace AND n.nspname = 'public'
      WHERE t.typtype = 'e' ORDER BY 1`
    expect(enums.map((r) => r.typname), 'tipos enum encontrados (use text + CHECK)').toEqual([])
  })
})

describe('Varredor: INV-60 (índice único em particionada contém a chave de partição)', () => {
  it('todo índice único de tabela particionada inclui a chave de partição', async () => {
    // Postgres já recusa isto no DDL; o varredor é a rede de segurança.
    const parts = await dono<{ tabela: string; colpart: string }[]>`
      SELECT c.relname AS tabela, a.attname AS colpart
        FROM pg_partitioned_table p
        JOIN pg_class c ON c.oid = p.partrelid
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (p.partattrs)
       WHERE c.relnamespace = 'public'::regnamespace`
    const violacoes: string[] = []
    for (const { tabela, colpart } of parts) {
      const idxUnicos = await dono<{ indexname: string; cols: string[] }[]>`
        SELECT i.relname AS indexname,
               array_agg(a.attname) AS cols
          FROM pg_index x
          JOIN pg_class i ON i.oid = x.indexrelid
          JOIN pg_class t ON t.oid = x.indrelid AND t.relname = ${tabela}
          JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (x.indkey)
         WHERE x.indisunique
         GROUP BY i.relname`
      for (const idx of idxUnicos) {
        if (!idx.cols.includes(colpart)) violacoes.push(`${tabela}.${idx.indexname} sem ${colpart}`)
      }
    }
    expect(violacoes, violacoes.join(', ')).toEqual([])
  })
})

describe('Varredor: INV-04 (FK para PK composta é composta)', () => {
  it('FK que referencia tabela de PK composta usa todas as colunas', async () => {
    const fks = await dono<{ tabela: string; constraint: string; ncols: number; npk: number }[]>`
      SELECT con.conname AS constraint,
             cl.relname  AS tabela,
             array_length(con.conkey, 1)  AS ncols,
             (SELECT array_length(pk.conkey, 1)
                FROM pg_constraint pk
               WHERE pk.conrelid = con.confrelid AND pk.contype = 'p') AS npk
        FROM pg_constraint con
        JOIN pg_class cl ON cl.oid = con.conrelid AND cl.relnamespace = 'public'::regnamespace
       WHERE con.contype = 'f'`
    const violacoes = fks
      .filter((f) => f.npk && f.npk > 1 && f.ncols < f.npk)
      .map((f) => `${f.tabela}.${f.constraint} (${f.ncols}/${f.npk} cols)`)
    expect(violacoes, `FKs incompletas para PK composta: ${violacoes.join(', ')}`).toEqual([])
  })
})

describe('Varredor: Partições (próximos 3 meses cobertos)', () => {
  it('toda tabela particionada por mês tem partição para os próximos 3 meses', async () => {
    const parts = await dono<{ tabela: string }[]>`
      SELECT c.relname AS tabela FROM pg_partitioned_table p
      JOIN pg_class c ON c.oid = p.partrelid AND c.relnamespace = 'public'::regnamespace
      WHERE p.partstrat = 'r'`
    const violacoes: string[] = []
    for (const { tabela } of parts) {
      // Conta partições cujo bound superior é > hoje+3meses (basta uma cobrindo o futuro).
      const [linha] = await dono<{ cobre: boolean }[]>`
        SELECT bool_or(
                 pg_get_expr(ch.relpartbound, ch.oid) ~ 'TO'
                 AND (regexp_match(pg_get_expr(ch.relpartbound, ch.oid), 'TO \\(''([0-9-]+)'))[1]::date
                     >= (now() + interval '3 months')::date
               ) AS cobre
          FROM pg_inherits inh
          JOIN pg_class parent ON parent.oid = inh.inhparent AND parent.relname = ${tabela}
          JOIN pg_class ch ON ch.oid = inh.inhrelid`
      if (!linha?.cobre) violacoes.push(tabela)
    }
    expect(violacoes, `particionadas sem cobertura de 3 meses: ${violacoes.join(', ')}`).toEqual([])
  })
})

describe('Varredor: Numeração de migration (nono varredor)', () => {
  it('não há prefixo numérico duplicado em infra/migrations', () => {
    // ⚠️ O "prefixo" é o token ANTES do primeiro `_` (ex.: 0003 e 0003b são
    //    DISTINTOS — o sufixo de letra é convenção do repo para migration irmã).
    const prefixos = readdirSync(DIR_MIGRATIONS)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => f.split('_')[0] ?? '')
      .filter((p) => /^\d/.test(p))
    const vistos = new Set<string>()
    const dup = new Set<string>()
    for (const p of prefixos) { if (vistos.has(p)) dup.add(p); vistos.add(p) }
    expect([...dup], `prefixos de migration duplicados: ${[...dup].join(', ')}`).toEqual([])
  })
})

describe('Varredor: INV-02 (schema Zod de borda não carrega tenantId)', () => {
  it('nenhum z.object de borda contém tenantId', () => {
    // Heurística: procura `tenantId` dentro de arquivos que usam Zod no shared/api.
    const alvos = [
      resolve(RAIZ, 'packages/shared/src'),
      resolve(RAIZ, 'apps/api/src'),
    ]
    const violacoes: string[] = []
    const varrer = (dir: string): void => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = resolve(dir, ent.name)
        if (ent.isDirectory()) { varrer(p); continue }
        if (!ent.name.endsWith('.ts') || ent.name.endsWith('.test.ts')) continue
        const src = readFileSync(p, 'utf8')
        if (!src.includes('z.object')) continue
        // Só acusa se `tenantId` aparecer numa linha de definição de campo Zod.
        for (const linha of src.split('\n')) {
          if (/tenantId\s*:/.test(linha) && /z\.(string|uuid|coerce)/.test(linha)) {
            violacoes.push(`${p.replace(RAIZ + '/', '')}: ${linha.trim()}`)
          }
        }
      }
    }
    for (const a of alvos) varrer(a)
    expect(violacoes, `Zod de borda com tenantId (vem do token, ADR-001): ${violacoes.join(' | ')}`).toEqual([])
  })
})
