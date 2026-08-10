import postgres from 'postgres'
import { criarApp } from './app.js'
import { encerrarBanco } from './db/index.js'
import { iniciarBarramento } from './contexts/atendimento/eventos/barramento.js'
import { despacharTodos, type FetchFn } from './contexts/integracao/webhook-saida.js'

const porta = Number(process.env.PORT ?? 3000)

const app = await criarApp()

// ⚠️ Uma ÚNICA conexão LISTEN por instância (ADR-007). Fica fora do criarApp()
//    para os testes (app.inject) não abrirem um LISTEN nem competir por conexão.
await iniciarBarramento()

// Despachante de webhooks de saída (INT-07). Roda como DONO (worker) e é guardado
// por advisory lock, então várias instâncias não entregam em dobro. Intervalo
// fora do criarApp() para os testes não dispararem entrega de rede.
let despachoWebhook: ReturnType<typeof setInterval> | undefined
let donoWebhook: ReturnType<typeof postgres> | undefined
if (process.env.DATABASE_ADMIN_URL) {
  // ⚠️ max:1 de propósito: o despacho é serial e o advisory lock precisa de
  //    lock+unlock na MESMA conexão. Uma pool maior vazaria o lock entre
  //    conexões e somaria conexões ociosas ao pool principal + ao LISTEN.
  donoWebhook = postgres(process.env.DATABASE_ADMIN_URL, { max: 1, onnotice: () => {} })
  const entregar: FetchFn = (url, init) =>
    fetch(url, init as RequestInit).then((r) => ({ ok: r.ok, status: r.status }))
  // ⚠️ Guarda anti-sobreposição: se uma passada demora (fetch lento), a próxima
  //    tick NÃO empilha — senão conexões e trabalho se acumulam sem teto.
  let despachando = false
  despachoWebhook = setInterval(() => {
    if (despachando) return
    despachando = true
    void despacharTodos(donoWebhook as never, entregar, new Date())
      .catch((e) => app.log.warn({ erro: e }, 'despacho de webhooks de saída falhou'))
      .finally(() => { despachando = false })
  }, 20_000)
}

// Graceful shutdown: para de aceitar requisição, termina as que estão em voo,
// e só então fecha o banco. Encerrar o pool antes derruba transação aberta.
for (const sinal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sinal, async () => {
    app.log.info({ sinal }, 'encerrando')
    if (despachoWebhook) clearInterval(despachoWebhook)
    await app.close()
    if (donoWebhook) await donoWebhook.end()
    await encerrarBanco()
    process.exit(0)
  })
}

await app.listen({ port: porta, host: '0.0.0.0' })
