import { randomUUID } from 'node:crypto'
import type { Sql } from '../../db/index.js'
import type { EventoMeta, EventoQualidadeMeta } from './canais/meta.js'

/**
 * QUALIDADE DO NÚMERO E STATUS DE TEMPLATE — os eventos da Meta que vêm POR
 * WABA (raia P11; playbook da AM §2.5).
 *
 * ⚠️ Só BANCO, nenhuma rede: roda dentro do request do webhook, que grava e
 *    responde. Tudo idempotente — a Meta reenvia o que demora:
 *    - suspensão: só a PRIMEIRA queda suspende, alerta e notifica; a repetição
 *      não empilha aviso;
 *    - histórico de saúde: só grava quando o valor MUDA;
 *    - template: o mesmo status reaplicado não muda nada.
 *
 * ⚠️ Suspende só as ATIVAS não transacionais (o retorno do agente). Resposta a
 *    quem escreveu continua — calar o atendimento por causa da qualidade seria
 *    piorar a nota que se quer proteger.
 */

export const TIPO_ALERTA_QUALIDADE = 'qualidade_numero'
/** Teto de pessoas notificadas por evento — e ele é visível no retorno. */
const TETO_NOTIFICADOS = 20

export type ResultadoQualidade = 'suspendeu' | 'ja_suspensa' | 'agravou' | 'liberou' | 'sem_mudanca'

/** Aplica um evento de qualidade/conta a UM canal (tenant já setado). */
export async function aplicarQualidadeNumero(
  tx: Sql, canalId: string, ev: EventoQualidadeMeta, agora: Date,
): Promise<{ resultado: ResultadoQualidade; notificados: number }> {
  const [c] = await tx<{ nome: string; suspensa: Date | null; motivo: string | null }[]>`
    SELECT nome_amigavel AS nome, ativas_suspensas_em AS suspensa, ativas_suspensas_motivo AS motivo
      FROM canal_conectado WHERE tenant_id = tenant_atual() AND id = ${canalId}
       FOR UPDATE`
  if (!c) return { resultado: 'sem_mudanca', notificados: 0 }

  // Histórico de saúde (0011): só quando muda — é a resposta a "quando começou a cair?".
  const campo = ev.campo === 'account_update' ? 'conta' : 'qualidade'
  const para = ev.qualidade ? `${ev.evento}:${ev.qualidade}` : ev.evento
  const [ultimo] = await tx<{ para: string }[]>`
    SELECT para FROM canal_saude_evento
     WHERE tenant_id = tenant_atual() AND canal_id = ${canalId} AND campo = ${campo}
     ORDER BY criado_em DESC LIMIT 1`
  if (ultimo?.para !== para) {
    await tx`
      INSERT INTO canal_saude_evento (tenant_id, id, canal_id, campo, de, para, criado_em)
      VALUES (tenant_atual(), ${randomUUID()}, ${canalId}, ${campo}, ${ultimo?.para ?? null}, ${para}, ${agora})`
  }

  if (ev.baixa === true) {
    const motivo = `${campo}:${ev.evento}${ev.qualidade ? `:${ev.qualidade}` : ''}`
    const texto = campo === 'conta'
      ? `A Meta restringiu a conta do número ${c.nome} (${ev.evento}). Retornos do agente e campanhas deste número foram `
        + 'suspensos; respostas a quem escreve continuam. Confira a conta no Gerenciador do WhatsApp e libere na tela do agente.'
      : `A qualidade do número ${c.nome} caiu (${ev.qualidade ?? ev.evento}). Retornos do agente e campanhas deste número `
        + 'foram suspensos até a Meta normalizar; respostas a quem escreve continuam.'
    if (c.suspensa) {
      // ⚠️ Restrição de CONTA sobre uma suspensão de QUALIDADE agrava o motivo:
      //    sem isto, o UNFLAGGED seguinte liberaria uma conta restrita.
      if (campo === 'conta' && !(c.motivo ?? '').startsWith('conta:')) {
        await tx`
          UPDATE canal_conectado SET ativas_suspensas_motivo = ${motivo}
           WHERE tenant_id = tenant_atual() AND id = ${canalId}`
        await tx`
          UPDATE alerta SET mensagem = ${texto}
           WHERE tenant_id = tenant_atual() AND tipo = ${TIPO_ALERTA_QUALIDADE} AND resolvido_em IS NULL`
        return { resultado: 'agravou', notificados: 0 }
      }
      return { resultado: 'ja_suspensa', notificados: 0 }
    }
    await tx`
      UPDATE canal_conectado SET ativas_suspensas_em = ${agora}, ativas_suspensas_motivo = ${motivo}
       WHERE tenant_id = tenant_atual() AND id = ${canalId}`
    await abrirAlertaQualidade(tx, texto)
    const notificados = await notificarQualidade(tx, canalId, `Número ${c.nome}: retornos e campanhas suspensos pela Meta (${ev.qualidade ?? ev.evento})`)
    return { resultado: 'suspendeu', notificados }
  }

  // ⚠️ Volta automática SÓ para queda de QUALIDADE. Restrição de conta não tem
  //    evento de "voltou" confiável: quem libera é uma pessoa, na tela.
  if (ev.baixa === false && c.suspensa && (c.motivo ?? '').startsWith('qualidade:')) {
    await liberarAtivas(tx, canalId, agora)
    return { resultado: 'liberou', notificados: 0 }
  }
  return { resultado: 'sem_mudanca', notificados: 0 }
}

/**
 * Libera as ativas do canal e, se nenhum outro número do tenant segue suspenso,
 * resolve o alerta. Usado pela volta da qualidade e pelo "Liberar" da tela.
 */
export async function liberarAtivas(tx: Sql, canalId: string, agora: Date): Promise<boolean> {
  const [l] = await tx<{ id: string }[]>`
    UPDATE canal_conectado SET ativas_suspensas_em = NULL, ativas_suspensas_motivo = NULL
     WHERE tenant_id = tenant_atual() AND id = ${canalId} AND ativas_suspensas_em IS NOT NULL
     RETURNING id`
  if (!l) return false
  const [outro] = await tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM canal_conectado
     WHERE tenant_id = tenant_atual() AND ativas_suspensas_em IS NOT NULL`
  if ((outro?.n ?? 0) === 0) {
    await tx`
      UPDATE alerta SET resolvido_em = ${agora}
       WHERE tenant_id = tenant_atual() AND tipo = ${TIPO_ALERTA_QUALIDADE} AND resolvido_em IS NULL`
  }
  return true
}

async function abrirAlertaQualidade(tx: Sql, mensagem: string): Promise<void> {
  // ⚠️ Um aberto por tipo (índice parcial de 0031): com dois números caindo,
  //    o segundo não abre outro — a tela de ativas mostra cada número.
  const nova = await tx<{ id: string }[]>`
    INSERT INTO alerta (tenant_id, id, tipo, severidade, mensagem)
    VALUES (tenant_atual(), ${randomUUID()}, ${TIPO_ALERTA_QUALIDADE}, 'critico', ${mensagem})
    ON CONFLICT (tenant_id, tipo) WHERE resolvido_em IS NULL DO NOTHING
    RETURNING id`
  if (nova.length > 0) {
    await tx`
      INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id, payload)
      VALUES (tenant_atual(), 'alerta.novo', 'tenant', tenant_atual(), '{}'::jsonb)`
  }
}

/**
 * Notifica quem cuida do número: quem tem acesso a ele (`usuario_canal`) ou,
 * sem ninguém declarado, os usuários ativos. Notificação SEM conversa — o
 * assunto é o número. Payload do evento só com o id do usuário (ADR-007).
 */
async function notificarQualidade(tx: Sql, canalId: string, titulo: string): Promise<number> {
  let alvos = (await tx<{ id: string }[]>`
    SELECT uc.usuario_id AS id FROM usuario_canal uc
      JOIN usuario u ON u.tenant_id = uc.tenant_id AND u.id = uc.usuario_id AND u.ativo
     WHERE uc.tenant_id = tenant_atual() AND uc.canal_id = ${canalId}
     LIMIT ${TETO_NOTIFICADOS}`).map((u) => u.id)
  if (alvos.length === 0) {
    alvos = (await tx<{ id: string }[]>`
      SELECT id FROM usuario WHERE tenant_id = tenant_atual() AND ativo LIMIT ${TETO_NOTIFICADOS}`).map((u) => u.id)
  }
  for (const usuarioId of alvos) {
    await tx`
      INSERT INTO notificacao (tenant_id, id, usuario_id, tipo, titulo, conversa_id)
      VALUES (tenant_atual(), ${randomUUID()}, ${usuarioId}, 'canal.qualidade', ${titulo}, NULL)`
    await tx`
      INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id, payload)
      VALUES (tenant_atual(), 'notificacao.nova', 'usuario', ${usuarioId},
              ${JSON.stringify({ usuarioId })}::text::jsonb)`
  }
  return alvos.length
}

// ─────────────────────────────────────────────────────────────────────────────
// Status de template
// ─────────────────────────────────────────────────────────────────────────────

/** Evento da Meta → o nosso `status_meta` (CHECK de 0011b). `null` = só registra o evento. */
export function statusDoTemplate(evento: string): 'APPROVED' | 'REJECTED' | 'PAUSED' | 'DISABLED' | 'PENDING' | null {
  switch (evento) {
    case 'APPROVED': case 'REINSTATED': return 'APPROVED'
    case 'REJECTED': return 'REJECTED'
    case 'PAUSED': return 'PAUSED'
    case 'DISABLED': case 'PENDING_DELETION': return 'DISABLED'
    case 'PENDING': case 'IN_APPEAL': return 'PENDING'
    // FLAGGED: qualidade do template caindo — ainda envia; só o evento fica gravado.
    default: return null
  }
}

/**
 * Persiste o status de template vindo do webhook (tenant já setado).
 *
 * A versão alvo é a que a Meta conhece pelo id (`id_externo`); sem o id, a
 * versão MAIS RECENTE daquele nome/idioma — é a que foi submetida por último.
 * ⚠️ Aprovar uma versão desativa a aprovada anterior: o índice parcial de 0011b
 *    só admite UMA aprovada, e o envio usa sempre a vigente.
 */
export async function aplicarStatusTemplate(
  tx: Sql, ev: Extract<EventoMeta, { tipo: 'template_status' }>, agora: Date,
): Promise<{ atualizado: boolean; templateId: string | null }> {
  const [alvo] = await tx<{ template_id: string; versao: number; status_meta: string; status_atualizado_em: Date | null }[]>`
    SELECT tv.template_id, tv.versao, tv.status_meta, tv.status_atualizado_em
      FROM template t
      JOIN template_versao tv ON tv.tenant_id = t.tenant_id AND tv.template_id = t.id
     WHERE t.tenant_id = tenant_atual() AND t.nome = ${ev.nome}
       AND (${ev.idioma}::text IS NULL OR t.idioma = ${ev.idioma})
     ORDER BY (${ev.templateIdExterno}::text IS NOT NULL AND tv.id_externo = ${ev.templateIdExterno}) DESC, tv.versao DESC
     LIMIT 1`
  if (!alvo) return { atualizado: false, templateId: null }
  // ⚠️ Fora de ordem: evento GERADO antes do último aplicado não regride o
  //    status (PAUSED de ontem chegando depois do REINSTATED de hoje).
  const momento = ev.momento ?? agora
  if (alvo.status_atualizado_em && momento.getTime() < alvo.status_atualizado_em.getTime()) {
    return { atualizado: false, templateId: alvo.template_id }
  }

  const status = statusDoTemplate(ev.status)
  if (status === 'APPROVED' && alvo.status_meta !== 'APPROVED') {
    await tx`
      UPDATE template_versao SET status_meta = 'DISABLED', status_atualizado_em = ${momento}
       WHERE tenant_id = tenant_atual() AND template_id = ${alvo.template_id}
         AND status_meta = 'APPROVED' AND versao <> ${alvo.versao}`
  }
  await tx`
    UPDATE template_versao SET
      status_meta = coalesce(${status}::text, status_meta),
      motivo_rejeicao = CASE WHEN ${status}::text = 'REJECTED'
                             THEN coalesce(${ev.motivo}::text, motivo_rejeicao, 'A Meta não informou o motivo.')
                             ELSE motivo_rejeicao END,
      id_externo = coalesce(id_externo, ${ev.templateIdExterno}::text),
      status_evento_meta = ${ev.status},
      status_atualizado_em = ${momento},
      revisado_em = ${agora}
     WHERE tenant_id = tenant_atual() AND template_id = ${alvo.template_id} AND versao = ${alvo.versao}`
  return { atualizado: true, templateId: alvo.template_id }
}
