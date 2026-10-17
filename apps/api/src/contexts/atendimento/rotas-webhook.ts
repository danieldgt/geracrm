import type { FastifyInstance } from 'fastify'
import { sql, comTenantServico } from '../../db/index.js'
import { parseWebhookPlugZapi } from './canais/plugzapi.js'
import { ingerirMensagemEntrante, registrarStatusMensagem } from './ingestao-mensagem.js'

/**
 * Webhook de entrada dos canais — o que faz o Inbox acender.
 *
 * ⚠️ PÚBLICO: o fornecedor (PlugZapi) chama sem o nosso JWT. O identificador é o
 * `canalId` na URL — por ele achamos tenant + canal. É por isso que a rota NÃO
 * usa `exigirTenant`.
 *
 * ⚠️ Regra do webhook (o código HTTP é INSTRUÇÃO): sempre 200 quando
 * processamos, mesmo ignorando o evento — senão o PlugZapi reenvia em loop e
 * trava a fila. Só erro nosso não-tratado sobe como 500 (aí o reenvio ajuda).
 */
export async function rotasWebhook(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { canalId: string } }>(
    '/webhooks/plugzapi/:canalId',
    async (req, reply) => {
      const canalId = req.params.canalId
      if (!/^[0-9a-f-]{36}$/i.test(canalId)) {
        return reply.code(400).send({ erro: 'canal.id_invalido' })
      }

      // ⚠️ Descobre o tenant pela função SECURITY DEFINER — a única porta
      //    autorizada, porque canal_conectado tem RLS FORCE e o webhook não tem
      //    tenant setado. Devolve só tenant/provedor/estado, nada mais.
      const [canal] = await sql<{
        tenant_id: string; provedor: string | null; estado: string; arquivado_em: Date | null
      }[]>`
        SELECT tenant_id, provedor, estado, arquivado_em FROM tenant_do_canal(${canalId}::uuid)
      `
      if (!canal) {
        // 404 e não 200: canal inexistente não é evento a ignorar, é URL errada.
        return reply.code(404).send({ erro: 'canal.nao_encontrado' })
      }
      // ⚠️ Número arquivado (0083): 200 e descarta. A instância pode continuar
      //    viva no fornecedor depois que o número saiu da frota — ingerir criaria
      //    conversa num canal que sumiu da tela, invisível para quem atende. E é
      //    200, não erro: falha PERMANENTE que devolve erro trava a fila de
      //    TODOS os clientes na entrega sequencial.
      if (canal.arquivado_em) {
        req.log.warn({ canalId }, 'webhook de canal arquivado descartado')
        return reply.code(200).send({ ok: true, descartado: 'canal_arquivado' })
      }

      const evento = parseWebhookPlugZapi(req.body)
      if (evento.tipo === 'ignorado') {
        // ⚠️ 200 mesmo ignorando — o PlugZapi só precisa saber que recebemos.
        req.log.debug({ canalId, motivo: evento.motivo }, 'webhook ignorado')
        return reply.code(200).send({ ok: true, ignorado: evento.motivo })
      }

      // Status de entrega (os dois tiques) de uma mensagem NOSSA.
      if (evento.tipo === 'status_mensagem') {
        try {
          await comTenantServico(canal.tenant_id, (tx) =>
            registrarStatusMensagem(tx, evento.idExterno, evento.status))
          return reply.code(200).send({ ok: true, status: evento.status })
        } catch (erro) {
          req.log.error({ erro, canalId }, 'falha ao registrar status de mensagem')
          return reply.code(500).send({ erro: 'erro.interno' })
        }
      }

      try {
        const r = await comTenantServico(canal.tenant_id, (tx) =>
          ingerirMensagemEntrante(tx, canalId, evento.mensagem))
        if (!r.ok) {
          // Falha de dado (telefone inválido): registra e encerra com 200 — o
          // reenvio não conserta um telefone torto.
          req.log.warn({ canalId, motivo: r.motivo }, 'mensagem entrante descartada')
          return reply.code(200).send({ ok: true, descartado: r.motivo })
        }
        req.log.info(
          { canalId, conversaId: r.conversaId, duplicada: r.duplicada, leadNovo: r.leadNovo },
          'mensagem entrante ingerida',
        )
        // ⚠️ O NOTIFY é disparado pela TRIGGER do outbox no COMMIT (migration
        //    0026) — transacional por construção. Reentrega (duplicada) não
        //    grava outbox, então não republica.
        //
        // ⚠️ ENXUTO (raia P11): nenhuma rede antes do 200. A resposta de
        //    AUSÊNCIA e a cópia da mídia (E5-14) foram AGENDADAS pela ingestão
        //    na mesma transação (`tarefa_pos_ingestao`) e saem pelo worker de
        //    pós-ingestão, com retry e com o desfecho registrado no log de lá —
        //    inclusive o silêncio ("por que o agente não respondeu?").
        return reply.code(200).send({ ok: true })
      } catch (erro) {
        // ⚠️ Erro NOSSO (banco fora, bug): 500 para o PlugZapi reenviar — a
        //    mensagem do cliente não pode se perder por uma falha transitória.
        req.log.error({ erro, canalId }, 'falha ao ingerir mensagem entrante')
        return reply.code(500).send({ erro: 'erro.interno' })
      }
    },
  )
}
