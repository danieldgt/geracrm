import { fileURLToPath } from 'node:url'
import { guardaServidorNoBanco } from './src/db/servidor-no-banco.js'

/**
 * Roda UMA vez, antes de todos os arquivos: recusa a suíte se um servidor com workers
 * estiver ligado no mesmo banco (ver `servidor-no-banco.ts` — causa de teste instável
 * reproduzida na P0d). Banco inacessível: avisa e segue.
 */
export default async function (): Promise<void> {
  try {
    process.loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url)))
  } catch {
    // CI: variáveis vêm do ambiente.
  }
  const url = process.env.DATABASE_ADMIN_URL
  if (url) await guardaServidorNoBanco(url)
}
