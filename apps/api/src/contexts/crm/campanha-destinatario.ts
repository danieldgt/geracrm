import { randomUUID } from 'node:crypto'
import {
  ERROS_META_DESTINATARIO, JANELA_RESPOSTA_DIAS, ROTULO_MOTIVO_PAUSA, classificarErroMeta, type MotivoPausa,
} from '@geracrm/shared'
import type { Sql } from '../../db/index.js'
import { auditar } from '../plataforma/auditoria.js'
import { algumCanal, canaisDosUsuarios } from '../plataforma/preferencia-notificacao.js'

/**
 * O DESTINATÁRIO DA CAMPANHA V2 depois do envio: status da Meta, resposta, opt-out e a
 * pausa (com o aviso ao gestor). Tudo sob tenant (RLS), tudo idempotente — o webhook
 * reenvia o que demora e o despachante roda a cada 30 s.
 *
 * ⚠️ O estado só AVANÇA: enviada (1) < entregue (2) < lida (3) < respondeu (4). Os
 *    webhooks chegam fora de ordem (lida antes de entregue); cada marco tem o PRÓPRIO
 *    instante (`entregue_em`, `lido_em`…), então o funil conta certo mesmo quando o
 *    estado pulou um degrau. `optout` e `falhou` são terminais.
 */

const ORDEM = `CASE estado WHEN 'enviada' THEN 1 WHEN 'entregue' THEN 2 WHEN 'lida' THEN 3 WHEN 'respondeu' THEN 4 ELSE 0 END`

/**
 * Status de entrega pelo wamid (oficial e não oficial chegam aqui por
 * `registrarStatusMensagem`). Envio de teste e mensagem que não é de campanha não têm
 * destinatário: zero linhas, sem erro.
 */
export async function registrarStatusDestinatario(
  tx: Sql, idExterno: string, status: 'enviada' | 'entregue' | 'lida', em: Date,
): Promise<boolean> {
  const ordem = status === 'enviada' ? 1 : status === 'entregue' ? 2 : 3
  const marco = status === 'entregue' ? tx`entregue_em = coalesce(entregue_em, ${em})`
    : status === 'lida' ? tx`lido_em = coalesce(lido_em, ${em}), entregue_em = coalesce(entregue_em, ${em})`
    : tx`enviado_em = coalesce(enviado_em, ${em})`
  const linhas = await tx`
    UPDATE campanha_destinatario
       SET ${marco},
           estado = CASE WHEN estado IN ('enviando', 'enviada', 'entregue', 'lida') AND ${tx.unsafe(ORDEM)} < ${ordem}
                         THEN ${status} ELSE estado END,
           atualizado_em = ${em}
     WHERE tenant_id = tenant_atual() AND wamid = ${idExterno}
       AND estado NOT IN ('falhou', 'excluida', 'pendente')
    RETURNING id`
  return linhas.length > 0
}

/**
 * A Meta avisou que a mensagem FALHOU depois de aceita. Vira `falhou` com o código.
 *   - erro do DESTINATÁRIO (131026, 131049…): é da pessoa, não do número — fica FORA da
 *     taxa de falha da pausa automática;
 *   - erro de NÚMERO EM RISCO (131031, 131048, 131056, 130429, 368): a campanha pausa NA
 *     HORA (`numero_em_risco`), sem esperar a amostra de 50 — insistir derruba o número;
 *   - o resto entra na taxa de falha.
 * Entregue/lida não regridem.
 */
export async function registrarFalhaDestinatario(
  tx: Sql, idExterno: string, erroCodigo: string | null, em: Date,
): Promise<boolean> {
  const linhas = await tx<{ campanha_id: string }[]>`
    UPDATE campanha_destinatario
       SET estado = 'falhou', erro_codigo = ${erroCodigo ?? 'falha_meta'}, atualizado_em = ${em}
     WHERE tenant_id = tenant_atual() AND wamid = ${idExterno} AND estado IN ('enviando', 'enviada')
    RETURNING campanha_id`
  if (linhas[0] && classificarErroMeta(erroCodigo) === 'numero_em_risco') {
    await pausarCampanha(tx, { campanhaId: linhas[0].campanha_id, motivo: 'numero_em_risco', agora: em })
  }
  return linhas.length > 0
}

/**
 * O cliente escreveu no MESMO número em até 7 dias do envio: a resposta é da campanha
 * (atribuição, #78). Chamado pela ingestão da mensagem entrante NOVA (a duplicada nem
 * chega aqui). Marca o envio mais recente de cada campanha alcançada; `optout` e
 * `falhou` ficam como estão.
 */
export async function marcarRespostaDeCampanha(
  tx: Sql, p: { contatoId: string; canalId: string; recebidaEm: Date },
): Promise<number> {
  const linhas = await tx`
    UPDATE campanha_destinatario d
       SET estado = 'respondeu', respondeu_em = ${p.recebidaEm}, atualizado_em = ${p.recebidaEm},
           entregue_em = coalesce(d.entregue_em, ${p.recebidaEm})
      FROM campanha k
     WHERE d.tenant_id = tenant_atual() AND d.contato_id = ${p.contatoId}
       AND k.tenant_id = d.tenant_id AND k.id = d.campanha_id AND k.canal_id = ${p.canalId}
       AND d.estado IN ('enviada', 'entregue', 'lida')
       AND d.enviado_em <= ${p.recebidaEm}
       AND d.enviado_em > ${p.recebidaEm}::timestamptz - make_interval(days => ${JANELA_RESPOSTA_DIAS})
    RETURNING d.id`
  return linhas.length
}

/**
 * Quem RECEBEU e depois entrou na lista de bloqueio (pediu para sair) vira `optout`.
 * ⚠️ Reconciliação, não gatilho: o opt-out nasce em vários caminhos (palavra "pare" no
 *    pipeline do agente, tela de Bloqueios, denúncia) e nenhum deles precisa saber de
 *    campanha. A data do bloqueio depois do envio é o que separa "saiu por causa da
 *    campanha" de "já estava fora" (esse nem foi enviado).
 */
export async function reconciliarOptOuts(tx: Sql, campanhaId: string, agora: Date): Promise<number> {
  const linhas = await tx`
    UPDATE campanha_destinatario d
       SET estado = 'optout', optout_em = lb.bloqueado_em, atualizado_em = ${agora}
      FROM lista_bloqueio lb
     WHERE d.tenant_id = tenant_atual() AND d.campanha_id = ${campanhaId}
       AND d.enviado_em IS NOT NULL AND d.estado IN ('enviada', 'entregue', 'lida', 'respondeu')
       AND lb.tenant_id = d.tenant_id AND lb.chave_bloqueio = d.telefone_chave
       AND lb.bloqueado_em >= d.enviado_em
    RETURNING d.id`
  return linhas.length
}

/** As contagens da pausa automática desde `contagem_desde` (início ou última retomada). */
export async function contagemParaPausa(
  tx: Sql, campanhaId: string, desde: Date | null,
): Promise<{ enviados: number; optouts: number; processados: number; falhas: number }> {
  const aPartir = desde === null ? tx`true` : tx`coalesce(enviado_em, atualizado_em) >= ${desde}`
  const [r] = await tx<{ enviados: number; optouts: number; processados: number; falhas: number }[]>`
    SELECT count(*) FILTER (WHERE enviado_em IS NOT NULL)::int AS enviados,
           count(*) FILTER (WHERE estado = 'optout')::int AS optouts,
           count(*) FILTER (WHERE enviado_em IS NOT NULL OR estado = 'falhou')::int AS processados,
           -- Erro do DESTINATÁRIO (não é WhatsApp, limite por pessoa…) não é falha do número.
           count(*) FILTER (WHERE estado = 'falhou'
                              AND coalesce(erro_codigo, '') <> ALL(${[...ERROS_META_DESTINATARIO]}::text[]))::int AS falhas
      FROM campanha_destinatario
     WHERE tenant_id = tenant_atual() AND campanha_id = ${campanhaId} AND ${aPartir}`
  return r ?? { enviados: 0, optouts: 0, processados: 0, falhas: 0 }
}

export const TIPO_ALERTA_CAMPANHA = 'campanha_pausada'
const TETO_NOTIFICADOS = 20

/**
 * Pausa a campanha (só se ainda estiver em curso) e, se a pausa é AUTOMÁTICA, abre o
 * alerta e notifica a gestão (admin/gestor; sem papel atribuído, os usuários ativos).
 * Devolve `false` se outra pessoa/passada já mudou o estado.
 * ⚠️ Payload do evento só com o id (ADR-007): a tela busca a notificação por API.
 */
export async function pausarCampanha(
  tx: Sql, p: { campanhaId: string; motivo: MotivoPausa; agora: Date; atorId?: string | null; atorStaff?: boolean },
): Promise<boolean> {
  const [c] = await tx<{ nome: string }[]>`
    UPDATE campanha SET estado = 'pausada', pausa_motivo = ${p.motivo}, pausada_em = ${p.agora}, atualizado_em = ${p.agora}
     WHERE tenant_id = tenant_atual() AND id = ${p.campanhaId} AND estado IN ('agendada', 'enviando')
    RETURNING nome`
  if (!c) return false
  await auditar(tx, {
    atorId: p.atorId ?? null, atorStaff: p.atorStaff ?? false,
    acao: p.motivo === 'manual' ? 'campanha.pausada' : 'campanha.pausada_automaticamente',
    entidade: 'campanha', entidadeId: p.campanhaId, dados: { motivo: p.motivo },
  })
  if (p.motivo === 'manual') return true

  const texto = `Campanha "${c.nome}" pausada. ${ROTULO_MOTIVO_PAUSA[p.motivo]}. Confira e retome na tela de campanhas.`
  const novo = await tx<{ id: string }[]>`
    INSERT INTO alerta (tenant_id, id, tipo, severidade, mensagem)
    VALUES (tenant_atual(), ${randomUUID()}, ${TIPO_ALERTA_CAMPANHA}, 'critico', ${texto})
    ON CONFLICT (tenant_id, tipo) WHERE resolvido_em IS NULL DO UPDATE SET mensagem = EXCLUDED.mensagem
    RETURNING id`
  if (novo.length > 0) {
    await tx`
      INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id, payload)
      VALUES (tenant_atual(), 'alerta.novo', 'tenant', tenant_atual(), '{}'::jsonb)`
  }
  let alvos = (await tx<{ id: string }[]>`
    SELECT DISTINCT u.id FROM usuario u
      JOIN usuario_filial uf ON uf.tenant_id = u.tenant_id AND uf.usuario_id = u.id AND uf.papel IN ('admin', 'gestor')
     WHERE u.tenant_id = tenant_atual() AND u.ativo
     LIMIT ${TETO_NOTIFICADOS}`).map((u) => u.id)
  if (alvos.length === 0) {
    alvos = (await tx<{ id: string }[]>`
      SELECT id FROM usuario WHERE tenant_id = tenant_atual() AND ativo LIMIT ${TETO_NOTIFICADOS}`).map((u) => u.id)
  }
  // D4: cada pessoa escolhe por onde recebe; quem desligou o aviso não ganha linha.
  const canais = await canaisDosUsuarios(tx, alvos, 'campanha.pausada')
  for (const usuarioId of alvos) {
    const canal = canais.get(usuarioId)
    if (!canal || !algumCanal(canal)) continue
    await tx`
      INSERT INTO notificacao (tenant_id, id, usuario_id, tipo, titulo, conversa_id, no_app, email_pendente)
      VALUES (tenant_atual(), ${randomUUID()}, ${usuarioId}, 'campanha.pausada',
              ${`Campanha "${c.nome}" pausada automaticamente`}, NULL, ${canal.app}, ${canal.email})`
    if (canal.app) {
      await tx`
        INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id, payload)
        VALUES (tenant_atual(), 'notificacao.nova', 'usuario', ${usuarioId}, ${JSON.stringify({ usuarioId })}::text::jsonb)`
    }
  }
  return true
}

/** Sem nenhuma campanha pausada automaticamente, o alerta de campanha se resolve. */
export async function resolverAlertaSeNenhumaPausada(tx: Sql, agora: Date): Promise<void> {
  const [n] = await tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM campanha
     WHERE tenant_id = tenant_atual() AND estado = 'pausada' AND pausa_motivo <> 'manual'`
  if ((n?.n ?? 0) === 0) {
    await tx`
      UPDATE alerta SET resolvido_em = ${agora}
       WHERE tenant_id = tenant_atual() AND tipo = ${TIPO_ALERTA_CAMPANHA} AND resolvido_em IS NULL`
  }
}

/**
 * Atribuição EXATA (M4): o pedido que nasce numa CONVERSA herda a campanha do envio mais
 * recente que alcançou o contato (entregue, lida ou respondida) dentro da janela de
 * atribuição DAQUELA campanha. Sem envio na janela, o pedido fica sem campanha (avulso).
 * Não sobrescreve um `campanha_id` já gravado.
 */
export async function atribuirCampanhaAoPedido(tx: Sql, pedidoId: string): Promise<string | null> {
  const [r] = await tx<{ campanha_id: string | null }[]>`
    UPDATE pedido p
       SET campanha_id = (
             SELECT d.campanha_id FROM campanha_destinatario d
               JOIN campanha k ON k.tenant_id = d.tenant_id AND k.id = d.campanha_id
              WHERE d.tenant_id = p.tenant_id AND d.contato_id = p.contato_id
                AND d.estado IN ('entregue', 'lida', 'respondeu')
                AND d.enviado_em >= p.criado_em - make_interval(days => k.janela_atribuicao_dias)
                AND d.enviado_em <= p.criado_em
              ORDER BY d.enviado_em DESC LIMIT 1)
     WHERE p.tenant_id = tenant_atual() AND p.id = ${pedidoId} AND p.campanha_id IS NULL
       AND p.conversa_id IS NOT NULL AND p.contato_id IS NOT NULL
    RETURNING p.campanha_id`
  return r?.campanha_id ?? null
}
