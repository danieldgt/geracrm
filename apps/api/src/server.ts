import postgres from 'postgres'
import { criarApp } from './app.js'
import { encerrarBanco } from './db/index.js'
import { iniciarBarramento } from './contexts/atendimento/eventos/barramento.js'
import { despacharTodos, type FetchFn } from './contexts/integracao/webhook-saida.js'
import { varrerAgendado, encerrarDonoAutomacao } from './contexts/crm/automacao-motor.js'
import {
  varrerSincronizacaoMidia, varrerConversoes,
  INTERVALO_SINCRONIZACAO_MS, INTERVALO_CONVERSOES_MS,
} from './contexts/aquisicao/worker.js'

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

// Motor de automações (varredura AGENDADA, ações internas — docs/automacoes.md).
// Roda como DONO, guardado por advisory lock (várias instâncias não varrem em
// dobro). Ciclo folgado: automação de recompra é por tempo, não precisa ser fina.
let varreduraAutomacao: ReturnType<typeof setInterval> | undefined
if (process.env.DATABASE_ADMIN_URL) {
  let varrendo = false
  varreduraAutomacao = setInterval(() => {
    if (varrendo) return
    varrendo = true
    void varrerAgendado(new Date())
      .catch((e) => app.log.warn({ erro: e }, 'varredura de automações falhou'))
      .finally(() => { varrendo = false })
  }, 300_000) // 5 min
}

// ─────────────────────────────────────────────────────────────────────────────
// Camada de aquisição (agencia-mkt) — DUAS varreduras, e a cota decide a cadência
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ A cota do developer token do Google é COMPARTILHADA entre todos os clientes.
//    Sincronizar de meia em meia hora não traria nada — métrica do Google fecha
//    por DIA — e custaria uma ordem de grandeza em contas atendidas (~15 contas
//    em vez de ~180). Por isso a sincronização é folgada (6h) e as conversões,
//    que não tocam essa cota, correm a cada 15 min.
// ⚠️ Sem as variáveis do Google configuradas, nada quebra: a fábrica devolve
//    adaptador com capacidades em `false` e a passada não faz nada de rede.
let sincronizacaoMidia: ReturnType<typeof setInterval> | undefined
let conversoesMidia: ReturnType<typeof setInterval> | undefined
let donoAquisicao: ReturnType<typeof postgres> | undefined
if (process.env.DATABASE_ADMIN_URL) {
  // max:1 pelo mesmo motivo do despachante de webhooks: advisory lock exige
  // lock+unlock na MESMA conexão.
  donoAquisicao = postgres(process.env.DATABASE_ADMIN_URL, { max: 1, onnotice: () => {} })

  let sincronizando = false
  sincronizacaoMidia = setInterval(() => {
    if (sincronizando) return
    sincronizando = true
    void varrerSincronizacaoMidia(donoAquisicao as never, { agora: new Date() })
      .then((r) => {
        if (r.contas > 0 || r.ignoradasPorSeremGerenciador > 0) {
          // ⚠️ `chamadas` é o número que diz quantas contas cabem na cota.
          app.log.info({ ...r, porConta: undefined }, 'sincronização de mídia')
        }
      })
      .catch((e) => app.log.warn({ erro: e }, 'sincronização de mídia falhou'))
      .finally(() => { sincronizando = false })
  }, INTERVALO_SINCRONIZACAO_MS)

  let convertendo = false
  conversoesMidia = setInterval(() => {
    if (convertendo) return
    convertendo = true
    void varrerConversoes(donoAquisicao as never, { agora: new Date() })
      .then((r) => {
        if (r.criadas > 0 || r.despacho.enviadas > 0 || r.despacho.falhadas > 0) {
          app.log.info(r, 'conversões de mídia')
        }
      })
      .catch((e) => app.log.warn({ erro: e }, 'varredura de conversões falhou'))
      .finally(() => { convertendo = false })
  }, INTERVALO_CONVERSOES_MS)
}

// Graceful shutdown: para de aceitar requisição, termina as que estão em voo,
// e só então fecha o banco. Encerrar o pool antes derruba transação aberta.
for (const sinal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sinal, async () => {
    app.log.info({ sinal }, 'encerrando')
    if (despachoWebhook) clearInterval(despachoWebhook)
    if (sincronizacaoMidia) clearInterval(sincronizacaoMidia)
    if (conversoesMidia) clearInterval(conversoesMidia)
    if (donoAquisicao) await donoAquisicao.end()
    if (varreduraAutomacao) clearInterval(varreduraAutomacao)
    await app.close()
    if (donoWebhook) await donoWebhook.end()
    await encerrarDonoAutomacao()
    await encerrarBanco()
    process.exit(0)
  })
}

await app.listen({ port: porta, host: '0.0.0.0' })
