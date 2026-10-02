import { randomUUID } from 'node:crypto'
import { ROTULO_HANDOFF, type MotivoHandoff } from '@geracrm/shared'
import type { Sql } from '../../../db/index.js'
import { notificarHandoffDoAgente } from '../notificacao.js'

/**
 * ENTREGA AO HUMANO — com contexto, ou não é entrega.
 *
 * ⚠️ O SDR anterior só mudava `agente_sessao.estado`: não criava atendimento,
 * não notificava, não resumia. O cliente repetia tudo para a pessoa — "handoff
 * sem contexto é pior que não ter agente" (escopo §3). Aqui:
 *
 *  1. garante um ATENDIMENTO aberto na fila (sem atendente), com protocolo;
 *  2. grava uma mensagem de SISTEMA na thread com o resumo e o motivo — é o
 *     que o atendente lê ao abrir;
 *  3. encerra a sessão do agente com o motivo;
 *  4. marca a conversa como conduzida por humano;
 *  5. notifica (fila ou dono da carteira) e emite o evento de tempo real.
 *
 * Tudo numa transação só, chamada pelo turno.
 */
export async function entregarParaHumano(
  tx: Sql,
  p: {
    conversaId: string; canalId: string; sessaoId: string | null
    motivo: MotivoHandoff | string; resumo: string; agora: Date
  },
): Promise<{ atendimentoId: string; criouAtendimento: boolean }> {
  const rotulo = (ROTULO_HANDOFF as Record<string, string>)[p.motivo] ?? p.motivo
  const atId = randomUUID()
  const [criado] = await tx<{ id: string }[]>`
    INSERT INTO atendimento (tenant_id, id, conversa_id, canal_id, protocolo, estado)
    VALUES (tenant_atual(), ${atId}, ${p.conversaId}, ${p.canalId}, proximo_numero(tenant_atual(), 'protocolo'), 'na_fila')
    ON CONFLICT (tenant_id, conversa_id) WHERE estado <> 'encerrado' DO NOTHING
    RETURNING id`
  const [aberto] = criado ? [criado] : await tx<{ id: string }[]>`
    SELECT id FROM atendimento WHERE tenant_id = tenant_atual() AND conversa_id = ${p.conversaId} AND estado <> 'encerrado' LIMIT 1`

  const texto = `Agente transferiu: ${rotulo}.${p.resumo ? `\nResumo: ${p.resumo}` : ''}`
  await tx`
    INSERT INTO mensagem (tenant_id, id, conversa_id, atendimento_id, direcao, tipo, conteudo, criado_em)
    VALUES (tenant_atual(), ${randomUUID()}, ${p.conversaId}, ${aberto?.id ?? null}, 'saliente', 'sistema',
            ${JSON.stringify({ texto, automatica: 'agente_handoff', motivo: p.motivo })}::text::jsonb, ${p.agora})`

  if (p.sessaoId) {
    await tx`
      UPDATE agente_sessao
         SET estado = 'entregue', fase = 'handoff', motivo_saida = ${`${rotulo}: ${p.resumo}`.slice(0, 200)}, encerrada_em = ${p.agora}
       WHERE tenant_id = tenant_atual() AND id = ${p.sessaoId} AND estado = 'ativa'`
  }

  const [conv] = await tx<{ versao: string }[]>`
    UPDATE conversa SET conduzida_por = 'humano', versao = versao + 1
     WHERE tenant_id = tenant_atual() AND id = ${p.conversaId} RETURNING versao`
  await tx`
    INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id, payload)
    VALUES (tenant_atual(), 'agente.handoff', 'conversa', ${p.conversaId},
            ${JSON.stringify({ conversaId: p.conversaId, versao: Number(conv?.versao ?? 0) })}::text::jsonb)`
  await notificarHandoffDoAgente(tx, p.conversaId, rotulo)
  return { atendimentoId: aberto?.id ?? atId, criouAtendimento: !!criado }
}
