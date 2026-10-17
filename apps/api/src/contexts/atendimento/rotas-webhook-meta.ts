import type { FastifyInstance } from 'fastify'
import { sql, comTenantServico } from '../../db/index.js'
import { parseWebhookMeta, verificarAssinaturaMeta, type EventoMeta } from './canais/meta.js'
import { ingerirMensagemEntrante, registrarStatusMensagem } from './ingestao-mensagem.js'
import { PREFIXO_MIDIA_META } from './canais/meta-oficial.js'
import { aplicarQualidadeNumero, aplicarStatusTemplate } from './qualidade-numero.js'
import type { MensagemEntrante } from './canais/porta.js'

/**
 * Webhook da Meta (WhatsApp Cloud API / Instagram Direct).
 *
 * ⚠️ PÚBLICO e sem o nosso JWT — a Meta chama direto. A autenticidade vem da
 * ASSINATURA (`X-Hub-Signature-256` = HMAC-SHA256 do corpo cru com o App Secret),
 * não de token de sessão. Por isso este plugin tem parser de BUFFER próprio
 * (encapsulado): a assinatura precisa do corpo exatamente como veio.
 *
 * ⚠️ O código HTTP é INSTRUÇÃO (skill geracrm-whatsapp-meta): 2xx encerra; erro
 * faz a Meta reenviar. Assinatura inválida → 401 (não é evento da Meta, é ruído;
 * a Meta legítima sempre assina, então não entra em loop). Evento reconhecido →
 * sempre 200.
 *
 * ⚠️ ENXUTO (raia P11): o request só VALIDA, GRAVA e AGENDA — nenhuma chamada de
 * rede antes do 200. A resposta automática (ausência) e o download da mídia
 * eram feitos aqui, pós-commit: um provedor lento segurava o 2xx e, com a
 * entrega sequencial da Meta, a fila de TODOS os clientes. Agora a ingestão
 * agenda `tarefa_pos_ingestao` na mesma transação e o worker de pós-ingestão
 * executa com retry. Qualidade do número e status de template são só banco.
 */
export async function rotasWebhookMeta(app: FastifyInstance): Promise<void> {
  // Parser de buffer SÓ neste escopo — mantém o corpo cru para o HMAC e ainda
  // entrega o JSON já parseado ao handler. O resto da API segue no parser padrão.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    const buf = body as Buffer
    ;(_req as unknown as { rawBody?: Buffer }).rawBody = buf
    try { done(null, buf.length ? JSON.parse(buf.toString('utf8')) : {}) }
    catch (e) { done(e as Error, undefined) }
  })

  // Handshake de verificação (Meta chama ao configurar o callback no painel).
  app.get('/webhooks/meta', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>
    const token = process.env.META_VERIFY_TOKEN
    if (q['hub.mode'] === 'subscribe' && token && q['hub.verify_token'] === token) {
      // ⚠️ Devolve o challenge em texto puro — a Meta compara byte a byte.
      return reply.type('text/plain').send(q['hub.challenge'] ?? '')
    }
    return reply.code(403).send({ erro: 'verify.falhou' })
  })

  // Recebimento de eventos (mensagem, status, qualidade, status de template).
  app.post('/webhooks/meta', async (req, reply) => {
    const secret = process.env.META_APP_SECRET
    if (!secret) {
      // Sem segredo não dá para verificar autenticidade — recusa e avisa no log.
      req.log.error('META_APP_SECRET ausente — webhook Meta recusado')
      return reply.code(401).send({ erro: 'nao_configurado' })
    }
    const raw = (req as unknown as { rawBody?: Buffer }).rawBody
    const assinatura = req.headers['x-hub-signature-256'] as string | undefined
    if (!raw || !verificarAssinaturaMeta(raw, assinatura, secret)) {
      return reply.code(401).send({ erro: 'assinatura_invalida' })
    }

    const eventos = parseWebhookMeta(req.body)
    const agora = new Date()
    for (const ev of eventos) {
      if (ev.tipo === 'ignorado') continue

      // Qualidade do número / conta e status de template chegam POR WABA.
      // Só banco; erro NOSSO (banco) → 500 para a Meta reenviar.
      if (ev.tipo === 'qualidade' || ev.tipo === 'template_status') {
        try {
          const canais = await sql<{ tenant_id: string; canal_id: string }[]>`
            SELECT tenant_id, canal_id
              FROM canais_meta_por_waba(${ev.wabaId}, ${ev.tipo === 'qualidade' ? ev.telefone : null})`
          if (canais.length === 0) {
            // ⚠️ Sem alvo é falha PERMANENTE: 200 + log (a WABA pode ainda não
            //    ter sido sincronizada — o worker de pós-ingestão preenche).
            req.log.warn({ tipo: ev.tipo, wabaId: ev.wabaId }, 'webhook meta: nenhum canal para a WABA')
            continue
          }
          if (ev.tipo === 'qualidade') {
            for (const c of canais) {
              const r = await comTenantServico(c.tenant_id, (tx) => aplicarQualidadeNumero(tx, c.canal_id, ev, agora))
              req.log.info({ canalId: c.canal_id, evento: ev.evento, qualidade: ev.qualidade, baixa: ev.baixa, ...r }, 'webhook meta: qualidade do número')
            }
          } else {
            for (const tenantId of new Set(canais.map((c) => c.tenant_id))) {
              const r = await comTenantServico(tenantId, (tx) => aplicarStatusTemplate(tx, ev, agora))
              req.log.info({ template: ev.nome, status: ev.status, ...r }, 'webhook meta: status de template')
            }
          }
        } catch (erro) {
          req.log.error({ erro, tipo: ev.tipo }, 'webhook meta: falha ao processar evento da WABA')
          return reply.code(500).send({ erro: 'erro.interno' })
        }
        continue
      }

      // Roteia por phone_number_id → tenant/canal (função SECURITY DEFINER).
      const [canal] = await sql<{ tenant_id: string; canal_id: string; estado: string }[]>`
        SELECT tenant_id, canal_id, estado FROM canal_por_identificador_externo(${ev.phoneNumberId})`
      if (!canal) {
        // ⚠️ Roteamento sem alvo é falha PERMANENTE: 200 + log, senão a Meta
        //    reenvia para sempre e trava a fila de todos.
        req.log.warn({ phoneNumberId: ev.phoneNumberId }, 'webhook meta: canal não encontrado')
        continue
      }

      try {
        if (ev.tipo === 'mensagem') {
          // Texto, resposta de botão, imagem e áudio. Vídeo/documento/figurinha
          // ainda não entram — reconhecidos e logados (200).
          const entrante = mensagemEntranteMeta(ev)
          if (!entrante) {
            req.log.info({ tipo: ev.conteudo.tipo === 'outro' ? ev.conteudo.tipoCru : ev.conteudo.tipo }, 'webhook meta: tipo ainda não ingerido')
            continue
          }
          // ⚠️ A ingestão grava a mensagem E agenda, no mesmo commit, a resposta
          //    automática (ausência — vale no oficial igual: quem escreve às 23h
          //    merece a mesma resposta, venha por onde vier) e o download da mídia
          //    (`meta:media:<id>` → nosso bucket). Os dois são rede e saem pelo
          //    worker de pós-ingestão, com retry. A janela de 24h segue aberta
          //    quando o worker roda: o cliente acabou de escrever.
          const r = await comTenantServico(canal.tenant_id, (tx) => ingerirMensagemEntrante(tx, canal.canal_id, entrante))
          if (r.ok) req.log.info({ canalId: canal.canal_id, conversaId: r.conversaId, duplicada: r.duplicada }, 'mensagem entrante ingerida (meta)')
        } else if (ev.status === 'enviada' || ev.status === 'entregue' || ev.status === 'lida') {
          await comTenantServico(canal.tenant_id, (tx) => registrarStatusMensagem(tx, ev.idExterno, ev.status as 'enviada' | 'entregue' | 'lida'))
        }
        // status 'falhou' → tratamento (marcar mensagem falhou) entra depois.
      } catch (erro) {
        // ⚠️ Erro NOSSO (transitório, ex.: banco) → 500 para a Meta reenviar.
        req.log.error({ erro, phoneNumberId: ev.phoneNumberId }, 'webhook meta: falha ao processar')
        return reply.code(500).send({ erro: 'erro.interno' })
      }
    }
    return reply.code(200).send({ ok: true, eventos: eventos.length })
  })
}

/**
 * Do evento já parseado para a `MensagemEntrante` da porta. `null` = tipo que
 * ainda não ingerimos. A mídia entra com o placeholder `meta:media:<id>` em
 * `midiaUrl`: o download é outro passo, fora do caminho da requisição.
 */
export function mensagemEntranteMeta(ev: Extract<EventoMeta, { tipo: 'mensagem' }>): MensagemEntrante | null {
  const base = { deE164: ev.de, idExterno: ev.idExterno, nomeRemetente: ev.nomePerfil ?? undefined, recebidaEm: new Date(ev.timestamp * 1000) }
  const c = ev.conteudo
  if (c.tipo === 'texto') return { ...base, tipo: 'texto', texto: c.texto }
  if (c.tipo === 'imagem') {
    return { ...base, tipo: 'imagem', midiaUrl: `${PREFIXO_MIDIA_META}${c.midiaId}`, mime: c.mime ?? undefined, texto: c.legenda ?? undefined }
  }
  if (c.tipo === 'audio') return { ...base, tipo: 'audio', midiaUrl: `${PREFIXO_MIDIA_META}${c.midiaId}`, mime: c.mime ?? undefined }
  return null
}
