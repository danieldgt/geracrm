import Fastify, { type FastifyInstance } from 'fastify'
import { sql } from './db/index.js'
import { pluginTenant, exigirTenant } from './plugins/tenant.js'
import { pluginTestarConexao } from './contexts/integracao/testar-conexao.js'
import { rotasIntegracao } from './contexts/integracao/rotas.js'
import { rotasSync } from './contexts/integracao/rotas-sync.js'
import { rotasWebhooksSaida } from './contexts/integracao/rotas-webhooks-saida.js'
import { rotasContatos } from './contexts/crm/rotas-contatos.js'
import { rotasBloqueios } from './contexts/crm/rotas-bloqueios.js'
import { rotasFunil } from './contexts/crm/rotas-funil.js'
import { rotasLeads } from './contexts/crm/rotas-leads.js'
import { rotasCrmAvancado } from './contexts/crm/rotas-crm-avancado.js'
import { rotasSegmentos } from './contexts/crm/rotas-segmentos.js'
import { rotasTarefa } from './contexts/crm/rotas-tarefa.js'
import { rotasCarteira } from './contexts/crm/rotas-carteira.js'
import { rotasMeta } from './contexts/crm/rotas-meta.js'
import { rotasLista } from './contexts/crm/rotas-lista.js'
import { rotasRetencao } from './contexts/crm/rotas-retencao.js'
import { rotasNps } from './contexts/crm/rotas-nps.js'
import { rotasSequencia } from './contexts/crm/rotas-sequencia.js'
import { rotasAutomacao } from './contexts/crm/rotas-automacao.js'
import { rotasFidelidade } from './contexts/crm/rotas-fidelidade.js'
import { rotasCampanha } from './contexts/crm/rotas-campanha.js'
import { rotasConversas } from './contexts/atendimento/rotas-conversas.js'
import { rotasCanais } from './contexts/atendimento/rotas-canais.js'
import { rotasCanalConfig } from './contexts/atendimento/rotas-canal-config.js'
import { rotasAgente } from './contexts/atendimento/agente/rotas-agente.js'
import { rotasMensagensLog } from './contexts/atendimento/rotas-mensagens-log.js'
import { rotasWebhook } from './contexts/atendimento/rotas-webhook.js'
import { rotasWebhookMeta } from './contexts/atendimento/rotas-webhook-meta.js'
import { rotasMensagens } from './contexts/atendimento/rotas-mensagens.js'
import { rotasFila } from './contexts/atendimento/rotas-fila.js'
import { rotasTemplate } from './contexts/atendimento/rotas-template.js'
import { rotasAtendimentoKanban } from './contexts/atendimento/rotas-atendimento-kanban.js'
import { rotasPresenca } from './contexts/atendimento/rotas-presenca.js'
import { rotasNotificacoes } from './contexts/atendimento/rotas-notificacoes.js'
import { rotasAuditoria } from './contexts/plataforma/rotas-auditoria.js'
import { rotasMetricas } from './contexts/plataforma/rotas-metricas.js'
import { rotasPainel } from './contexts/plataforma/rotas-painel.js'
import { rotasBi } from './contexts/plataforma/rotas-bi.js'
import { rotasPerformance } from './contexts/plataforma/rotas-performance.js'
import { rotasMercado } from './contexts/plataforma/rotas-mercado.js'
import { rotasMapa } from './contexts/plataforma/rotas-mapa.js'
import { rotasConfig } from './contexts/plataforma/rotas-config.js'
import { rotasClientes } from './contexts/plataforma/rotas-clientes.js'
import { rotasStaff } from './contexts/plataforma/rotas-staff.js'
import { rotasEventos } from './contexts/atendimento/eventos/rotas-eventos.js'
import { rotasPedido } from './contexts/pedido/rotas-pedido.js'
import { rotasAquisicao } from './contexts/aquisicao/rotas-aquisicao.js'
import { rotasLpPublica } from './contexts/aquisicao/rotas-lp-publica.js'
import { rotasPush } from './contexts/plataforma/rotas-push.js'
import { rotasAuth } from './contexts/identidade/rotas-auth.js'

/**
 * Builds the app without listening — so tests can use `app.inject()`
 * without opening a port.
 */
export async function criarApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      process.env.NODE_ENV === 'test'
        ? false
        : {
            level: process.env.LOG_LEVEL ?? 'info',
            // ⚠️ Conversation content must never reach the logs
            // (geracrm-observabilidade). Redact at the source, not later.
            redact: ['req.headers.authorization', 'req.headers["x-tenant-id"]'],
          },
  })

  // ⚠️ ANTES de qualquer `register`. No Fastify cada register cria um contexto
  //    encapsulado que herda o error handler NO MOMENTO do registro — definido
  //    depois, ele não retroage, e ficava valendo só para as rotas declaradas
  //    aqui no root (/saude, /pronto, /v1/eu). Todas as ~45 famílias de rota
  //    respondiam no formato cru do Fastify, e a tela recebia `erro: undefined`
  //    justamente quando precisava ramificar pelo código.
  app.setErrorHandler((erro, req, reply) => {
    const status = (erro as { statusCode?: number }).statusCode ?? 500
    if (status >= 500) req.log.error({ erro }, 'falha nao tratada')
    // Typed error, never the raw message — the screen needs a code it can branch on.
    // ⚠️ 403 precisa do próprio código: `exigirStaff` LANÇA (não usa reply.send),
    //    então cair no genérico fazia a tela receber status 403 com a mensagem
    //    "Erro interno." — o estado certo com o texto errado.
    const tipado: Record<number, { erro: string; mensagem: string }> = {
      401: { erro: 'autenticacao.ausente', mensagem: 'Autenticação ausente ou inválida.' },
      403: { erro: 'autorizacao.sem_permissao', mensagem: 'Você não tem acesso a esta área.' },
    }
    return reply.code(status).send(tipado[status] ?? { erro: 'erro.interno', mensagem: 'Erro interno.' })
  })

  await app.register(pluginTenant)
  await app.register(pluginTestarConexao)
  await app.register(rotasIntegracao)
  await app.register(rotasSync)
  await app.register(rotasWebhooksSaida)
  await app.register(rotasContatos)
  await app.register(rotasBloqueios)
  await app.register(rotasFunil)
  await app.register(rotasLeads)
  await app.register(rotasCrmAvancado)
  await app.register(rotasSegmentos)
  await app.register(rotasTarefa)
  await app.register(rotasCarteira)
  await app.register(rotasMeta)
  await app.register(rotasLista)
  await app.register(rotasRetencao)
  await app.register(rotasNps)
  await app.register(rotasSequencia)
  await app.register(rotasAutomacao)
  await app.register(rotasFidelidade)
  await app.register(rotasCampanha)
  await app.register(rotasConversas)
  await app.register(rotasCanais)
  await app.register(rotasCanalConfig)
  await app.register(rotasAgente)
  await app.register(rotasMensagensLog)
  await app.register(rotasWebhook)
  await app.register(rotasWebhookMeta)
  await app.register(rotasMensagens)
  await app.register(rotasFila)
  await app.register(rotasTemplate)
  await app.register(rotasAtendimentoKanban)
  await app.register(rotasPresenca)
  await app.register(rotasNotificacoes)
  await app.register(rotasAuditoria)
  await app.register(rotasMetricas)
  await app.register(rotasPainel)
  await app.register(rotasBi)
  await app.register(rotasPerformance)
  await app.register(rotasMercado)
  await app.register(rotasMapa)
  await app.register(rotasConfig)
  await app.register(rotasClientes)
  await app.register(rotasStaff)
  await app.register(rotasEventos)
  await app.register(rotasPedido)
  await app.register(rotasAquisicao)
  // ⚠️ Superfície PÚBLICA (sem token): a landing page do anúncio. O tenant é
  //    RESOLVIDO pela chave da URL (0062), como o webhook resolve pelo
  //    phone_number_id (0057) — nunca recebido em parâmetro (ADR-001).
  await app.register(rotasLpPublica)
  await app.register(rotasPush)
  await app.register(rotasAuth)

  /** Liveness — no database. Answers even with the bank down, on purpose. */
  /**
   * ⚠️ `versao` responde "o que está no ar AGORA?", e por isso é o COMMIT, não o
   * `npm_package_version` — que diz 0.0.0 desde o primeiro dia e que ninguém vai
   * lembrar de subir. É o mesmo dado que o rodapé do console mostra, para que a
   * pergunta "o deploy chegou?" tenha resposta sem abrir o painel do Railway.
   */
  app.get('/saude', async () => ({
    ok: true,
    versao: (process.env.RAILWAY_GIT_COMMIT_SHA ?? '').slice(0, 7) || 'local',
  }))

  /** Readiness — with database. This is the one the deploy should look at. */
  app.get('/pronto', async (_req, reply) => {
    try {
      await sql`SELECT 1`
      return { ok: true, banco: 'ok' }
    } catch {
      // Degrades in a localised way and names the failing subsystem, instead of
      // a generic 500 that says nothing to whoever is on call.
      return reply.code(503).send({ ok: false, banco: 'indisponivel' })
    }
  })

  /**
   * First domain route. Exists to prove the plugin end to end: the tenant comes
   * from the caller's identity, and RLS — not the query — decides what is
   * visible. Note there is no `WHERE tenant_id = ...` anywhere.
   */
  app.get('/v1/eu', { preHandler: exigirTenant }, async (req) => {
    return req.comTenant(async (tx) => {
      const [tenant] = await tx`
        SELECT t.id, t.nome, t.fuso, p.codigo AS plano, p.modulos
          FROM tenant t
          JOIN plano  p ON p.id = t.plano_id
      `
      return { tenant: tenant ?? null }
    })
  })

  return app
}
