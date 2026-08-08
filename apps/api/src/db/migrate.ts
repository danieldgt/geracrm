import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import postgres from 'postgres'
import { aplicarMigrations } from './migrations.js'

/**
 * Ponto de entrada do runner.
 *
 * ⚠️ Usa DATABASE_ADMIN_URL, não DATABASE_URL. Migration cria tabela e policy —
 * é operação de dono do schema. A API roda com um papel sem esses poderes, e é
 * assim que tem de ser (ver infra/dev/setup-dev.sql).
 */
const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_ADMIN_URL não definida — veja .env.example')

const aqui = dirname(fileURLToPath(import.meta.url))
const diretorio = resolve(aqui, '../../../../infra/migrations')

const sql = postgres(url, { max: 1, onnotice: () => {} })

try {
  console.log(`migrations: ${diretorio}`)
  const { aplicadas, jaAplicadas } = await aplicarMigrations(sql, diretorio)
  console.log(
    aplicadas.length === 0
      ? `nada a aplicar — ${jaAplicadas} já no banco`
      : `${aplicadas.length} aplicada(s), ${jaAplicadas} já estavam`,
  )
} catch (erro) {
  console.error('\n✗ migration falhou — o deploy NÃO deve prosseguir\n')
  console.error(erro instanceof Error ? erro.message : erro)
  process.exitCode = 1
} finally {
  await sql.end()
}
