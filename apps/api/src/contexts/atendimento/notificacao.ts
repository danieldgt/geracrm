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
 * ⚠️ **Sem atendente, notifica a FILA** — e isso mudou em 2026-08-25, depois do
 * primeiro disparo de campanha real. A regra anterior ("conversa na fila ainda
 * não é problema de ninguém em particular; o Inbox já mostra o não-lido")
 * funcionava para o inbox do dia a dia, com alguém olhando a tela. Ela falha
 * exatamente no caso que a camada de aquisição existe para resolver: a conversa
 * NASCIDA DE DISPARO não tem dono, então a resposta do lead caía numa fila que
 * não avisava ninguém. Com o console fechado, ninguém ficava sabendo — e
 * speed-to-lead em segundos era a promessa.
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
  if (alvo) {
    await notificar(tx, [alvo.atendente_id], 'mensagem.nova', alvo.titulo, p.conversaId)
    return
  }

  // ── Sem dono: é a FILA que precisa saber ────────────────────────────────
  const [contexto] = await tx<{ titulo: string; canal_id: string; dono_carteira: string | null }[]>`
    SELECT ct.nome AS titulo, c.canal_id,
           (SELECT ca.usuario_id FROM carteira_atribuicao ca
             WHERE ca.tenant_id = c.tenant_id AND ca.contato_id = c.contato_id AND ca.ate IS NULL
             LIMIT 1) AS dono_carteira
      FROM conversa c
      JOIN contato ct ON ct.tenant_id = c.tenant_id AND ct.id = c.contato_id
     WHERE c.tenant_id = tenant_atual() AND c.id = ${p.conversaId}`
  if (!contexto) return

  const alvos = await destinatariosDaFila(tx, contexto.canal_id, contexto.dono_carteira)
  if (alvos.length === 0) return
  await notificar(tx, alvos, 'fila.nova', contexto.titulo, p.conversaId)
}

/**
 * Quem é avisado quando a conversa não tem dono, em ordem de precisão.
 *
 * ⚠️ A ordem não é estética — é para o aviso ter DESTINATÁRIO, não audiência:
 *
 * 1. **Dono da carteira**, se houver. Quem tem a relação é quem deve responder;
 *    avisar o time inteiro sobre o cliente de alguém é ruído para todos e
 *    responsabilidade de ninguém.
 * 2. **Quem tem acesso ao canal** (`usuario_canal`, 0011). É o recorte que o
 *    produto já conhece: a vendedora que atende aquele número.
 * 3. **Todos os usuários ativos** — só quando ninguém declarou acesso. Numa
 *    operação pequena isso é o certo; e é melhor todo mundo saber do que
 *    ninguém.
 *
 * ⚠️ Teto de 20 e ele é VISÍVEL no retorno: com uma equipe grande e sem
 * `usuario_canal` configurado, o fallback (3) geraria uma notificação por
 * pessoa por conversa. Truncar em silêncio faria parecer que todo mundo foi
 * avisado.
 */
const TETO_FILA = 20

async function destinatariosDaFila(
  tx: Sql, canalId: string, donoCarteira: string | null,
): Promise<string[]> {
  if (donoCarteira) return [donoCarteira]

  const comAcesso = await tx<{ usuario_id: string }[]>`
    SELECT uc.usuario_id
      FROM usuario_canal uc
      JOIN usuario u ON u.tenant_id = uc.tenant_id AND u.id = uc.usuario_id AND u.ativo
     WHERE uc.tenant_id = tenant_atual() AND uc.canal_id = ${canalId}
     LIMIT ${TETO_FILA}`
  if (comAcesso.length > 0) return comAcesso.map((u) => u.usuario_id)

  const todos = await tx<{ id: string }[]>`
    SELECT id FROM usuario WHERE tenant_id = tenant_atual() AND ativo LIMIT ${TETO_FILA}`
  return todos.map((u) => u.id)
}

/** Grava a pendência e o evento de tempo real para cada destinatário. */
async function notificar(
  tx: Sql, usuarios: readonly string[], tipo: string, titulo: string, conversaId: string,
): Promise<void> {
  for (const usuarioId of usuarios) {
    // Uma pendência por (usuário, conversa): ON CONFLICT recende a existente.
    await tx`
      INSERT INTO notificacao (tenant_id, id, usuario_id, tipo, titulo, conversa_id)
      VALUES (tenant_atual(), ${randomUUID()}, ${usuarioId}, ${tipo}, ${titulo}, ${conversaId})
      ON CONFLICT (tenant_id, usuario_id, conversa_id) WHERE lida_em IS NULL AND conversa_id IS NOT NULL
      DO UPDATE SET criado_em = now(), titulo = EXCLUDED.titulo`

    // Evento no canal do usuário — só avisa "algo novo no seu sino".
    await tx`
      INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id, payload)
      VALUES (tenant_atual(), 'notificacao.nova', 'usuario', ${usuarioId},
              ${JSON.stringify({ usuarioId })}::text::jsonb)`
  }
}
