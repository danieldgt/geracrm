import { describe, it, expect, afterAll } from 'vitest'
import postgres from 'postgres'
import { APLICACAO_WORKERS, conexoesDeWorkersNoBanco, mensagemServidorNoBanco } from './servidor-no-banco.js'

/**
 * P0d — a guarda do globalSetup: um servidor com workers no mesmo banco da suíte é detectado
 * pelo `application_name` das conexões dono de `server.ts`.
 */
const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
afterAll(async () => { await dono.end() })

describe('Servidor com workers no banco da suíte', () => {
  it('uma conexão com o application_name dos workers é contada; fechada, some', async () => {
    const antes = await conexoesDeWorkersNoBanco(dono as never)
    const servidor = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {}, connection: { application_name: APLICACAO_WORKERS } })
    try {
      await servidor`SELECT 1`
      expect(await conexoesDeWorkersNoBanco(dono as never)).toBe(antes + 1)
    } finally {
      await servidor.end()
    }
    expect(await conexoesDeWorkersNoBanco(dono as never)).toBe(antes)
  })

  it('a mensagem diz o que fazer', () => {
    expect(mensagemServidorNoBanco(2, 'geracrm')).toMatch(/Pare o servidor.*banco próprio/)
  })
})
