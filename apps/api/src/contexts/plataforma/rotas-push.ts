import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { exigirTenant } from '../../plugins/tenant.js'
import { garantirUsuarioId } from '../atendimento/rotas-fila.js'
import { configVapid } from './push.js'

/**
 * Assinatura de push do navegador (PLT-07).
 *
 * ⚠️ **Degrada em vez de esconder.** Sem chaves VAPID no ambiente, `/v1/push/chave`
 * responde `{ disponivel: false }` com 200 — não 404, não 500. A tela então não
 * oferece o botão e diz por quê, em vez de oferecer algo que vai falhar.
 */
export async function rotasPush(app: FastifyInstance): Promise<void> {
  app.get('/v1/push/chave', { preHandler: exigirTenant }, async (_req, reply) => {
    const cfg = configVapid()
    // ⚠️ A chave PÚBLICA é pública mesmo — ela vai para dentro do navegador de
    //    todo mundo. Quem não pode sair daqui é a privada.
    return reply.send(cfg ? { disponivel: true, chave: cfg.publica } : { disponivel: false })
  })

  app.post<{ Body: { endpoint?: string; keys?: { p256dh?: string; auth?: string } } }>(
    '/v1/push/assinaturas', { preHandler: exigirTenant }, async (req, reply) => {
      const b = req.body ?? {}
      const endpoint = b.endpoint?.trim()
      const p256dh = b.keys?.p256dh?.trim()
      const auth = b.keys?.auth?.trim()
      if (!endpoint || !p256dh || !auth) {
        return reply.code(422).send({ erro: 'assinatura.incompleta' })
      }
      // ⚠️ Só https: endpoint de push é sempre https, e aceitar outra coisa
      //    seria aceitar um destino arbitrário para as nossas requisições.
      if (!endpoint.startsWith('https://')) {
        return reply.code(422).send({ erro: 'assinatura.endpoint_invalido' })
      }

      await req.comTenant(async (tx) => {
        const usuarioId = await garantirUsuarioId(tx, req)

        // ⚠️ O cursor NASCE NO TOPO na primeira assinatura do tenant: assinar
        //    hoje não pode disparar o histórico de notificações da semana
        //    passada no celular de alguém.
        await tx`
          INSERT INTO push_cursor (tenant_id, ate_criado_em)
          VALUES (tenant_atual(), now())
          ON CONFLICT (tenant_id) DO NOTHING`

        // Reassinar o MESMO navegador é caso comum (a permissão é renovada, o
        // service worker atualiza): atualiza as chaves e o dono, não duplica.
        await tx`
          INSERT INTO push_assinatura (tenant_id, id, usuario_id, endpoint, p256dh, auth)
          VALUES (tenant_atual(), ${randomUUID()}, ${usuarioId}, ${endpoint}, ${p256dh}, ${auth})
          ON CONFLICT (endpoint) DO UPDATE
            SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
                usuario_id = EXCLUDED.usuario_id, ultimo_erro = NULL`
      })
      return reply.code(201).send({ ok: true })
    })

  app.delete<{ Body: { endpoint?: string } }>(
    '/v1/push/assinaturas', { preHandler: exigirTenant }, async (req, reply) => {
      const endpoint = req.body?.endpoint?.trim()
      if (!endpoint) return reply.code(422).send({ erro: 'assinatura.incompleta' })
      await req.comTenant((tx) => tx`
        DELETE FROM push_assinatura
         WHERE tenant_id = tenant_atual() AND endpoint = ${endpoint}`)
      // Idempotente: desassinar o que já não existe é sucesso, não 404.
      return reply.send({ ok: true })
    })
}
