import type { FastifyInstance } from 'fastify'
import { sql, comTenantServico } from '../../db/index.js'
import { parseWebhookPlugZapi } from './canais/plugzapi.js'
import { ingerirMensagemEntrante, registrarStatusMensagem } from './ingestao-mensagem.js'
import { responderAutomaticamente } from './resposta-automatica.js'
import { midiaHabilitada } from './midia/armazenamento.js'
import { copiarMidiaEntrante } from './midia/copiar-entrante.js'

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
      const [canal] = await sql<{ tenant_id: string; provedor: string | null; estado: string }[]>`
        SELECT tenant_id, provedor, estado FROM tenant_do_canal(${canalId}::uuid)
      `
      if (!canal) {
        // 404 e não 200: canal inexistente não é evento a ignorar, é URL errada.
        return reply.code(404).send({ erro: 'canal.nao_encontrado' })
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

        // ⚠️ Resposta de AUSÊNCIA, pós-commit e best-effort. Fora do expediente,
        //    quem escreve merece saber que ninguém está — e quando alguém volta.
        //    Nunca derruba o 200: falhar aqui faria o PlugZapi reenviar a
        //    mensagem do cliente em loop por causa de uma cortesia.
        if (!r.duplicada) {
          try {
            const r2 = await responderAutomaticamente(canal.tenant_id, r.conversaId, canalId)
            if (r2.ausencia === 'enviada') {
              req.log.info({ canalId, conversaId: r.conversaId }, 'resposta de ausência enviada')
            }
            if (r2.agenteFalou) {
              req.log.info({ canalId, conversaId: r.conversaId, encerrouPor: r2.agenteEncerrouPor }, 'agente falou')
            }
          } catch (erro) {
            req.log.warn({ erro, canalId }, 'falha na resposta automática (mensagem do cliente já está salva)')
          }
        }

        // E5-14: copia a mídia da URL do provedor para o nosso bucket, PÓS-COMMIT
        // e best-effort — nunca falha o 200 (senão o PlugZapi reenviaria em loop).
        if (r.midiaExterna && midiaHabilitada()) {
          try {
            const copiada = await copiarMidiaEntrante(canal.tenant_id, r.midiaExterna)
            if (!copiada) req.log.warn({ canalId, conversaId: r.conversaId }, 'mídia de entrada mantida na URL do provedor (cópia falhou)')
          } catch (erro) {
            req.log.warn({ erro, canalId }, 'falha ao copiar mídia de entrada (mantém URL do provedor)')
          }
        }
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
