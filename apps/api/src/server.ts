import { criarApp } from './app.js'
import { encerrarBanco } from './db/index.js'

const porta = Number(process.env.PORT ?? 3000)

const app = await criarApp()

// Graceful shutdown: para de aceitar requisição, termina as que estão em voo,
// e só então fecha o banco. Encerrar o pool antes derruba transação aberta.
for (const sinal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sinal, async () => {
    app.log.info({ sinal }, 'encerrando')
    await app.close()
    await encerrarBanco()
    process.exit(0)
  })
}

await app.listen({ port: porta, host: '0.0.0.0' })
