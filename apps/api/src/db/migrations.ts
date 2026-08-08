import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import postgres from 'postgres'

/**
 * Migration runner.
 *
 * Runs in two places, and that is the point (ADR-006):
 *   - CI, on every PR — so the path that reaches production is exercised early
 *   - `preDeployCommand` on Railway — ⚠️ if it fails, the deploy does not
 *     proceed and the previous version keeps serving
 *
 * Consequence for whoever writes a migration: it runs BEFORE the new code, with
 * the previous version still handling traffic. So every migration must be
 * additive — dropping or renaming a column takes two or three deploys.
 */

export interface ResultadoMigracao {
  aplicadas: string[]
  jaAplicadas: number
}

const PADRAO_NOME = /^\d{4}[a-z]?_[a-z0-9_]+\.sql$/

function hashDe(conteudo: string): string {
  return createHash('sha256').update(conteudo).digest('hex').slice(0, 16)
}

export async function aplicarMigrations(
  sql: postgres.Sql,
  diretorio: string,
  log: (msg: string) => void = console.log,
): Promise<ResultadoMigracao> {
  const arquivos = (await readdir(diretorio))
    .filter((f) => f.endsWith('.sql'))
    .sort()

  // ⚠️ Nome fora do padrão não é preciosismo: a ordem de aplicação é a ordem
  // alfabética do nome. Um arquivo chamado "fix.sql" roda antes de "0001_" e
  // quebra tudo, em silêncio, só no ambiente onde ele existir.
  const invalidos = arquivos.filter((f) => !PADRAO_NOME.test(f))
  if (invalidos.length > 0) {
    throw new Error(
      `Migration com nome fora do padrão NNNN_descricao.sql: ${invalidos.join(', ')}. ` +
        'A ordem de aplicação é a ordem do nome — nome irregular roda na hora errada.',
    )
  }

  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      versao        text        PRIMARY KEY,
      aplicada_em   timestamptz NOT NULL DEFAULT now(),
      duracao_ms    integer,
      hash_conteudo text        NOT NULL
    )
  `

  const aplicadasAntes = await sql<{ versao: string; hash_conteudo: string }[]>`
    SELECT versao, hash_conteudo FROM schema_migrations
  `
  const conhecidas = new Map(aplicadasAntes.map((r) => [r.versao, r.hash_conteudo]))

  const aplicadas: string[] = []

  for (const arquivo of arquivos) {
    const versao = arquivo.replace(/\.sql$/, '')
    const conteudo = await readFile(join(diretorio, arquivo), 'utf8')
    const hash = hashDe(conteudo)

    const hashAnterior = conhecidas.get(versao)
    if (hashAnterior !== undefined) {
      // ⚠️ Migration já aplicada e alterada depois. Reaplicar não é opção
      // (ela já rodou), e ignorar faz os ambientes divergirem em silêncio:
      // este banco tem uma versão do schema e o próximo terá outra.
      if (hashAnterior !== hash) {
        throw new Error(
          `${arquivo} foi ALTERADA depois de aplicada (hash ${hashAnterior} → ${hash}). ` +
            'Migration aplicada é imutável: escreva uma nova, aditiva.',
        )
      }
      continue
    }

    const inicio = Date.now()
    // Cada arquivo em UMA transação: ou entra inteiro, ou não entra.
    // ⚠️ É por isso que CREATE INDEX CONCURRENTLY não cabe aqui.
    await sql.begin(async (tx) => {
      await tx.unsafe(conteudo)
      await tx`
        INSERT INTO schema_migrations (versao, duracao_ms, hash_conteudo)
        VALUES (${versao}, ${Date.now() - inicio}, ${hash})
      `
    })

    log(`  ✓ ${versao}  (${Date.now() - inicio}ms)`)
    aplicadas.push(versao)
  }

  return { aplicadas, jaAplicadas: conhecidas.size }
}
