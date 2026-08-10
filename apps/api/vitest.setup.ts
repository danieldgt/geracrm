import { fileURLToPath } from 'node:url'

/**
 * ⚠️ Carrega o .env da raiz do monorepo antes de qualquer teste.
 *
 * Sem isto, `vitest run` conecta com o usuário do sistema em vez do papel do
 * banco, e o erro é "password authentication failed for user <seu login>" —
 * que não se parece em nada com "faltou variável de ambiente" e faz perder
 * tempo procurando problema de permissão no Postgres.
 */
const env = fileURLToPath(new URL('../../.env', import.meta.url))

try {
  process.loadEnvFile(env)
} catch {
  // Em CI as variáveis vêm do ambiente; ausência do arquivo não é erro.
}
