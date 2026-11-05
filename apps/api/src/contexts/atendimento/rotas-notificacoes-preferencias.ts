import type { FastifyInstance } from 'fastify'
import {
  CANAIS_NOTIFICACAO, TIPOS_NOTIFICACAO, resolverCanais, validarPreferencias, type LinhaPreferencia,
} from '@geracrm/shared'
import { exigirTenant } from '../../plugins/tenant.js'
import { atorDaRequisicao } from './rotas-fila.js'

/**
 * Preferências de notificação (D4) — SEMPRE do usuário do token.
 *
 * ⚠️ O `usuario_id` sai do token (`atorDaRequisicao`), nunca de parâmetro: ninguém lê nem altera a
 * preferência do colega. Sessão de staff não tem usuário do cliente — não há preferência a mostrar.
 * Falta de linha = padrão do tipo (regra em `packages/shared`); a rota devolve a matriz JÁ resolvida.
 */
export async function rotasNotificacoesPreferencias(app: FastifyInstance): Promise<void> {
  app.get('/v1/notificacoes/preferencias', { preHandler: exigirTenant }, async (req, reply) => {
    const linhas = await req.comTenant(async (tx) => {
      const eu = await atorDaRequisicao(tx, req)
      if (!eu) return null
      return tx<LinhaPreferencia[]>`
        SELECT tipo, canal, ligado FROM usuario_preferencia_notificacao
         WHERE tenant_id = tenant_atual() AND usuario_id = ${eu}`
    })
    if (!linhas) return reply.code(403).send({ erro: 'acesso.staff_sem_usuario', mensagem: 'A sessão de suporte não tem preferências próprias.' })
    return reply.send({
      canais: CANAIS_NOTIFICACAO,
      tipos: TIPOS_NOTIFICACAO.map((t) => ({
        tipo: t.codigo, rotulo: t.rotulo, emailDisponivel: t.emailDisponivel, canais: resolverCanais(t.codigo, linhas),
      })),
    })
  })

  app.put('/v1/notificacoes/preferencias', { preHandler: exigirTenant }, async (req, reply) => {
    const v = validarPreferencias(req.body)
    if (!v.ok) return reply.code(422).send({ erro: v.erro, mensagem: v.mensagem })
    const gravadas = await req.comTenant(async (tx) => {
      const eu = await atorDaRequisicao(tx, req)
      if (!eu) return null
      for (const i of v.itens) {
        await tx`
          INSERT INTO usuario_preferencia_notificacao (tenant_id, usuario_id, tipo, canal, ligado)
          VALUES (tenant_atual(), ${eu}, ${i.tipo}, ${i.canal}, ${i.ligado})
          ON CONFLICT (tenant_id, usuario_id, tipo, canal) DO UPDATE SET ligado = EXCLUDED.ligado, atualizado_em = now()`
      }
      return v.itens.length
    })
    if (gravadas === null) return reply.code(403).send({ erro: 'acesso.staff_sem_usuario', mensagem: 'A sessão de suporte não tem preferências próprias.' })
    return reply.send({ ok: true, gravadas })
  })
}
