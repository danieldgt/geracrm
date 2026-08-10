import { randomUUID } from 'node:crypto'
import type { Sql } from '../../db/index.js'

/**
 * Notificações pessoais (PLT-07).
 *
 * ⚠️ O evento vai no OUTBOX, no MESMO commit da notificação e do dado que a
 * gerou — igual a toda emissão de tempo real (INV-40). O payload não carrega
 * conteúdo: avisa e o cliente busca por API sob RLS (ADR-007).
 */

/**
 * Notifica o atendente de uma conversa sobre uma mensagem entrante — SÓ se a
 * conversa foi assumida (tem atendimento aberto com atendente). Dedup por
 * índice parcial: uma pendência por (usuário, conversa); reentrada só recende
 * a existente (bump de criado_em), não empilha.
 *
 * Silencioso quando não há atendente: conversa na fila ainda não é problema de
 * ninguém em particular — o Inbox já mostra o não-lido.
 */
export async function notificarMensagemEntrante(
  tx: Sql,
  p: { conversaId: string },
): Promise<void> {
  const [alvo] = await tx<{ atendente_id: string; titulo: string }[]>`
    SELECT a.atendente_id, ct.nome AS titulo
      FROM atendimento a
      JOIN conversa c ON c.tenant_id = a.tenant_id AND c.id = a.conversa_id
      JOIN contato  ct ON ct.tenant_id = c.tenant_id AND ct.id = c.contato_id
     WHERE a.tenant_id = tenant_atual() AND a.conversa_id = ${p.conversaId}
       AND a.estado <> 'encerrado' AND a.atendente_id IS NOT NULL
     LIMIT 1`
  if (!alvo) return

  // Uma pendência por (usuário, conversa): ON CONFLICT recende a existente.
  const [n] = await tx<{ id: string }[]>`
    INSERT INTO notificacao (tenant_id, id, usuario_id, tipo, titulo, conversa_id)
    VALUES (tenant_atual(), ${randomUUID()}, ${alvo.atendente_id}, 'mensagem.nova',
            ${alvo.titulo}, ${p.conversaId})
    ON CONFLICT (tenant_id, usuario_id, conversa_id) WHERE lida_em IS NULL AND conversa_id IS NOT NULL
    DO UPDATE SET criado_em = now(), titulo = EXCLUDED.titulo
    RETURNING id`

  // Evento no canal do usuário — só avisa "algo novo no seu sino".
  await tx`
    INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id, payload)
    VALUES (tenant_atual(), 'notificacao.nova', 'usuario', ${alvo.atendente_id},
            ${JSON.stringify({ usuarioId: alvo.atendente_id })}::text::jsonb)`
  void n
}
