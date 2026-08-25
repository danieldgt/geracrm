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
import { vigiarTodos } from './contexts/aquisicao/vigia.js'
import { varrerResumoDiario, HORA_RESUMO_LOCAL } from './contexts/aquisicao/entrega-resumo.js'
import { despacharPush, configVapid, envioReal } from './contexts/plataforma/push.js'
import { despacharCampanhas } from './contexts/crm/despachante-campanha.js'
import { vigiarConexaoCanais } from './contexts/atendimento/vigia-canal.js'

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
let donoAquisicao: ReturnType<typeof postgres> | undefined
const intervalosAquisicao: ReturnType<typeof setInterval>[] = []
if (process.env.DATABASE_ADMIN_URL) {
  let sincronizacaoMidia: ReturnType<typeof setInterval>
  let conversoesMidia: ReturnType<typeof setInterval>
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
  intervalosAquisicao.push(sincronizacaoMidia, conversoesMidia)


  // Vigia de anomalia da mídia (AQ-07). ⚠️ De hora em hora, não a cada 6h como a
  // sincronização: o que ele vigia é gasto disparado e lead que parou de chegar —
  // e nesses dois, cada hora de atraso é dinheiro. Não gasta cota do Google: lê
  // só o que já está no nosso banco.
  let vigiaMidia: ReturnType<typeof setInterval> | undefined
  let vigiando = false
  vigiaMidia = setInterval(() => {
    if (vigiando) return
    vigiando = true
    void vigiarTodos(donoAquisicao as never, new Date())
      .then((r) => {
        if (r.abertos > 0 || r.resolvidos > 0) app.log.info(r, 'vigia de mídia')
      })
      .catch((e) => app.log.warn({ erro: e }, 'vigia de mídia falhou'))
      .finally(() => { vigiando = false })
  }, 60 * 60 * 1000)
  intervalosAquisicao.push(vigiaMidia)

  // ⚠️ VIGIA DE CONEXÃO DO CANAL — nasceu de um incidente real (24/ago): o número
  //    não-oficial caiu e o produto NÃO AVISOU. O painel seguia "conectado",
  //    porque o estado só era atualizado quando alguém tentava enviar.
  //    5 min: número fora do ar é o produto parado, e cada minuto é conversa
  //    perdida. Custa uma chamada HTTP por canal não-oficial.
  let vigiaCanal: ReturnType<typeof setInterval>
  let vigiandoCanal = false
  vigiaCanal = setInterval(() => {
    if (vigiandoCanal) return
    vigiandoCanal = true
    void vigiarConexaoCanais(donoAquisicao as never, new Date())
      .then((r) => {
        if (r.caiu > 0 || r.voltou > 0) app.log.warn(r, 'conexão de canal mudou')
      })
      .catch((e) => app.log.warn({ erro: e }, 'vigia de conexão de canal falhou'))
      .finally(() => { vigiandoCanal = false })
  }, 5 * 60 * 1000)
  intervalosAquisicao.push(vigiaCanal)

  // Resumo diário da mídia (AQ-08). ⚠️ 15 min NÃO é a frequência do resumo — é a
  // frequência com que se PERGUNTA se já passou das HORA_RESUMO_LOCAL h no fuso
  // de cada tenant. A entrega é uma por tenant por dia, travada pela chave
  // (tenant_id, dia) do `0061`; a passada frequente é o que faz o resumo sair
  // perto da hora certa mesmo com o processo tendo reiniciado às 19h59.
  let resumoMidia: ReturnType<typeof setInterval>
  let resumindo = false
  resumoMidia = setInterval(() => {
    if (resumindo) return
    resumindo = true
    void varrerResumoDiario(donoAquisicao as never, new Date())
      .then((r) => {
        if (r.entregues > 0) app.log.info({ ...r, hora: HORA_RESUMO_LOCAL }, 'resumo diário de mídia entregue')
      })
      .catch((e) => app.log.warn({ erro: e }, 'resumo diário de mídia falhou'))
      .finally(() => { resumindo = false })
  }, 15 * 60 * 1000)
  intervalosAquisicao.push(resumoMidia)

  // ⚠️ DESPACHANTE DE CAMPANHA. Sem ele, "disparar" só enfileirava: a tela dizia
  //    "disparando", os destinatários apareciam no painel e NENHUMA mensagem
  //    saía. 30s é ritmo de disparo, não de conversa — e o teto de aquecimento
  //    (0037) é quem realmente limita o volume do dia.
  let despachandoCampanha = false
  const campanhaIntervalo = setInterval(() => {
    if (despachandoCampanha) return
    despachandoCampanha = true
    void despacharCampanhas(donoAquisicao as never, new Date())
      .then((r) => {
        if (r.enviados > 0 || r.falhas > 0 || r.campanhasConcluidas > 0) {
          app.log.info(r, 'despacho de campanha')
        }
      })
      .catch((e) => app.log.warn({ erro: e }, 'despacho de campanha falhou'))
      .finally(() => { despachandoCampanha = false })
  }, 30_000)
  intervalosAquisicao.push(campanhaIntervalo)

  // Push nativo (PLT-07) — a notificação que chega com o navegador fechado.
  // ⚠️ 20s: é a mesma ordem de grandeza do despachante de webhooks. Push de
  //    atendimento tem que chegar em segundos; de minutos, o cliente já
  //    desistiu de esperar.
  // ⚠️ Sem chaves VAPID no ambiente, nem agenda: o produto segue com o sino, que
  //    é onde a notificação de fato está garantida.
  const vapid = configVapid()
  if (vapid) {
    const enviar = envioReal(vapid)
    let empurrando = false
    const pushIntervalo = setInterval(() => {
      if (empurrando) return
      empurrando = true
      void despacharPush(donoAquisicao as never, enviar)
        .then((r) => {
          if (r.enviados > 0 || r.removidos > 0) app.log.info(r, 'push nativo')
        })
        .catch((e) => app.log.warn({ erro: e }, 'despacho de push falhou'))
        .finally(() => { empurrando = false })
    }, 20_000)
    intervalosAquisicao.push(pushIntervalo)
  } else {
    app.log.info('push nativo desligado (sem VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY)')
  }
}

// Graceful shutdown: para de aceitar requisição, termina as que estão em voo,
// e só então fecha o banco. Encerrar o pool antes derruba transação aberta.
for (const sinal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sinal, async () => {
    app.log.info({ sinal }, 'encerrando')
    if (despachoWebhook) clearInterval(despachoWebhook)
    for (const i of intervalosAquisicao) clearInterval(i)
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
