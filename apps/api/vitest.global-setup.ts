import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
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
  if (url) {
    await guardaServidorNoBanco(url)
    await avisarRelogioCruzado(url)
  }
}

/**
 * ⚠️ P0e: o Docker no macOS deixa o relógio do contêiner do Postgres ATRÁS do host pelo tempo
 * que o Mac ficou suspenso (medido: 15 min a cada "Maintenance Sleep"). A suíte não depende
 * mais disso — cada teste semeia pelo mesmo relógio do código que exercita —, mas o desvio
 * fica escrito na saída: é a primeira pergunta quando um teste de tempo falhar só "às vezes".
 * Só avisa; banco inacessível é assunto da guarda acima.
 */
async function avisarRelogioCruzado(url: string): Promise<void> {
  const dono = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 5 })
  try {
    const [r] = await dono<{ banco: Date }[]>`SELECT clock_timestamp() AS banco`
    const desvioS = Math.round((Date.now() - r!.banco.getTime()) / 1000)
    if (Math.abs(desvioS) > 60) {
      console.warn(`⚠️ Relógio do processo ${desvioS > 0 ? 'à frente' : 'atrás'} do Postgres em ${Math.abs(desvioS)} s `
        + '(Docker no macOS depois de suspender?). Reinicie o Docker Desktop para ressincronizar.')
    }
  } catch {
    // Banco inacessível: a guarda de servidor já avisou.
  } finally {
    await dono.end({ timeout: 1 })
  }
}
