import { randomUUID } from 'node:crypto'
import type { Sql } from '../../../db/index.js'

/**
 * A FILA DO AGENTE (ADR-024) — o turno sai do webhook.
 *
 * ⚠️ Uma tarefa PENDENTE por conversa. Mensagem nova reagenda a mesma tarefa
 * (debounce): "oi", "tem a camiseta", "em G?" em três webhooks viram UM turno
 * que lê as três. Sem isto o agente responde à primeira enquanto a terceira
 * chega — e responde de novo, por cima de si mesmo.
 *
 * ⚠️ `agendarTurno` roda na MESMA transação da ingestão (INV-40): se a mensagem
 * reverter, a tarefa some junto. O worker pega com FOR UPDATE SKIP LOCKED e
 * nunca duas da mesma conversa ao mesmo tempo.
 */

/** Quanto esperar por mais mensagens antes de responder. */
export const DEBOUNCE_MS = 3_000
/** Executando há mais que isto = processo morreu no meio; volta para a fila. */
export const PRAZO_EXECUCAO_MS = 120_000
export const MAX_TENTATIVAS = 3

export interface Tarefa {
  readonly tenant_id: string
  readonly id: string
  readonly conversa_id: string
  readonly canal_id: string
  readonly mensagens_ids: readonly string[]
  readonly tentativas: number
  readonly executar_em: Date
}

/**
 * Agenda (ou reagenda) o turno de uma conversa. Chamar DENTRO da transação que
 * gravou a mensagem — tenant já setado (`tenant_atual()`).
 */
export async function agendarTurno(
  tx: Sql,
  p: { conversaId: string; canalId: string; mensagemId?: string | undefined; agora: Date; atrasoMs?: number | undefined },
): Promise<{ tarefaId: string; reagendada: boolean }> {
  const executarEm = new Date(p.agora.getTime() + (p.atrasoMs ?? DEBOUNCE_MS))
  const novoId = randomUUID()
  const ids = p.mensagemId ? [p.mensagemId] : []
  const [linha] = await tx<{ id: string; reagendada: boolean }[]>`
    INSERT INTO agente_tarefa (tenant_id, id, conversa_id, canal_id, mensagens_ids, estado, executar_em)
    VALUES (tenant_atual(), ${novoId}, ${p.conversaId}, ${p.canalId}, ${ids}::uuid[], 'pendente', ${executarEm})
    ON CONFLICT (tenant_id, conversa_id) WHERE estado = 'pendente'
    DO UPDATE SET executar_em = EXCLUDED.executar_em,
                  mensagens_ids = agente_tarefa.mensagens_ids || EXCLUDED.mensagens_ids
    RETURNING id, (xmax <> 0) AS reagendada`
  return { tarefaId: linha!.id, reagendada: linha!.reagendada }
}

/**
 * Pega UMA tarefa vencida — como DONO (worker, sem tenant de sessão).
 *
 * ⚠️ Serial por conversa: não pega uma pendente cuja conversa já tem outra
 * executando (noutra instância). Duas instâncias nunca falam na mesma conversa.
 */
export async function pegarProximaTarefa(dono: Sql, agora: Date): Promise<Tarefa | null> {
  const [t] = await dono<Tarefa[]>`
    UPDATE agente_tarefa t
       SET estado = 'executando', iniciada_em = ${agora}, tentativas = tentativas + 1
     WHERE (t.tenant_id, t.id) = (
       SELECT p.tenant_id, p.id FROM agente_tarefa p
        WHERE p.estado = 'pendente' AND p.executar_em <= ${agora}
          AND NOT EXISTS (SELECT 1 FROM agente_tarefa e
                           WHERE e.tenant_id = p.tenant_id AND e.conversa_id = p.conversa_id
                             AND e.estado = 'executando')
        ORDER BY p.executar_em
        FOR UPDATE SKIP LOCKED
        LIMIT 1)
     RETURNING t.tenant_id, t.id, t.conversa_id, t.canal_id, t.mensagens_ids, t.tentativas, t.executar_em`
  return t ?? null
}

export async function concluirTarefa(dono: Sql, t: Pick<Tarefa, 'tenant_id' | 'id'>, agora: Date): Promise<void> {
  await dono`
    UPDATE agente_tarefa SET estado = 'concluida', concluida_em = ${agora}
     WHERE tenant_id = ${t.tenant_id} AND id = ${t.id}`
}

/**
 * Falhou. Volta para a fila com backoff, até o teto; depois marca `falhou` com o
 * erro — e quem olha a tela de decisões vê o motivo, não um silêncio.
 */
export async function falharTarefa(
  dono: Sql, t: Pick<Tarefa, 'tenant_id' | 'id' | 'tentativas'>, erro: string, agora: Date,
): Promise<'reagendada' | 'desistiu'> {
  if (t.tentativas >= MAX_TENTATIVAS) {
    await dono`
      UPDATE agente_tarefa SET estado = 'falhou', concluida_em = ${agora}, ultimo_erro = ${erro.slice(0, 500)}
       WHERE tenant_id = ${t.tenant_id} AND id = ${t.id}`
    return 'desistiu'
  }
  const atraso = 5_000 * 2 ** (t.tentativas - 1)
  await dono`
    UPDATE agente_tarefa SET estado = 'pendente', executar_em = ${new Date(agora.getTime() + atraso)},
           ultimo_erro = ${erro.slice(0, 500)}
     WHERE tenant_id = ${t.tenant_id} AND id = ${t.id}`
  return 'reagendada'
}

/** Reagenda a tarefa para já: chegou mensagem nova enquanto o turno rodava. */
export async function reagendarTarefa(dono: Sql, t: Pick<Tarefa, 'tenant_id' | 'id'>, agora: Date): Promise<void> {
  await dono`
    UPDATE agente_tarefa SET estado = 'pendente', executar_em = ${new Date(agora.getTime() + DEBOUNCE_MS)}
     WHERE tenant_id = ${t.tenant_id} AND id = ${t.id}`
}

/**
 * Tarefas presas em `executando` (processo morreu) voltam para a fila.
 * ⚠️ Com `ON CONFLICT` da única pendente por conversa: se enquanto isso nasceu
 * outra pendente, esta vira cancelada — a nova já cobre as mensagens.
 */
export async function recuperarTravadas(dono: Sql, agora: Date): Promise<number> {
  const limite = new Date(agora.getTime() - PRAZO_EXECUCAO_MS)
  const presas = await dono<{ tenant_id: string; id: string; conversa_id: string }[]>`
    SELECT tenant_id, id, conversa_id FROM agente_tarefa
     WHERE estado = 'executando' AND iniciada_em < ${limite}`
  for (const p of presas) {
    const [outra] = await dono<{ id: string }[]>`
      SELECT id FROM agente_tarefa WHERE tenant_id = ${p.tenant_id} AND conversa_id = ${p.conversa_id} AND estado = 'pendente'`
    await dono`
      UPDATE agente_tarefa
         SET estado = ${outra ? 'cancelada' : 'pendente'}, executar_em = ${agora},
             ultimo_erro = 'execução interrompida (processo reiniciou?)'
       WHERE tenant_id = ${p.tenant_id} AND id = ${p.id}`
  }
  return presas.length
}

/** Há mensagem entrante nesta conversa DEPOIS das que a tarefa cobre? */
export async function chegouMensagemNova(
  tx: Sql, conversaId: string, mensagensIds: readonly string[],
): Promise<boolean> {
  if (mensagensIds.length === 0) return false
  const [r] = await tx<{ nova: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM mensagem m
       WHERE m.tenant_id = tenant_atual() AND m.conversa_id = ${conversaId} AND m.direcao = 'entrante'
         AND m.criado_em > (SELECT max(x.criado_em) FROM mensagem x
                             WHERE x.tenant_id = tenant_atual() AND x.conversa_id = ${conversaId}
                               AND x.id = ANY(${[...mensagensIds]}::uuid[]))) AS nova`
  return r?.nova ?? false
}
