import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { conexoesDeWorkersNoBanco, mensagemServidorNoBanco } from './src/db/servidor-no-banco.js'

/**
 * Roda UMA vez, antes de todos os arquivos: recusa a suíte se um servidor com workers
 * estiver ligado no mesmo banco (ver `servidor-no-banco.ts` — causa de teste instável
 * reproduzida na P0d). Falhar aqui, com o motivo, é melhor que falhar ao acaso lá dentro.
 */
export default async function (): Promise<void> {
  try {
    process.loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url)))
  } catch {
    // CI: variáveis vêm do ambiente.
  }
  const url = process.env.DATABASE_ADMIN_URL
  if (!url) return
  const dono = postgres(url, { max: 1, onnotice: () => {} })
  try {
    const n = await conexoesDeWorkersNoBanco(dono as never)
    if (n > 0) {
      const [b] = await dono<{ banco: string }[]>`SELECT current_database() AS banco`
      throw new Error(mensagemServidorNoBanco(n, b?.banco ?? '?'))
    }
  } finally {
    await dono.end()
  }
}
