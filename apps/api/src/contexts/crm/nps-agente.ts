import { randomUUID } from 'node:crypto'
import { ehDetratorNps } from '@geracrm/shared'
import type { Sql } from '../../db/index.js'
import { gestoresDoTenant } from '../atendimento/sla-handoff.js'
import { notificarPessoasDaConversa } from '../atendimento/notificacao.js'

/**
 * NPS REGISTRADO PELO AGENTE (raia G3; AM `registrar_nps`). Módulo público do CRM
 * que a ferramenta `registrar_nps` chama.
 *
 * Modelo de NPS atual (0043/0045): a nota avalia o ATENDENTE (`atendente_id`,
 * usuário). O agente não é usuário — a nota dele nasce com `origem = 'agente'` e
 * `atendente_id` NULL, e o painel mostra o agente separado dos vendedores.
 *
 * ⚠️ Detrator (0–6) não espera automação: o gatilho `nps_detrator` só age se o
 *    tenant tiver criado a regra. Aqui nasce, no MESMO commit, uma tarefa para o
 *    gestor (o primeiro gestor presente; sem presente, o primeiro gestor; sem
 *    nenhum gestor, a tarefa fica sem dono e aparece para todos) e a notificação
 *    aos gestores presentes — ou a TODOS, se ninguém estiver presente. Uma regra
 *    `nps_detrator` configurada continua valendo por cima (age pelo contato).
 * Chamar sob tenant (RLS).
 */

const MAX_COMENTARIO = 500

export interface NpsDoAgente {
  readonly contatoId: string
  readonly conversaId: string
  readonly nota: number
  readonly comentario: string | null
  readonly agora: Date
}

export async function registrarNpsDoAgente(
  tx: Sql, p: NpsDoAgente,
): Promise<{ npsId: string; detrator: boolean; tarefaId: string | null }> {
  const npsId = randomUUID()
  const comentario = p.comentario?.trim() ? p.comentario.trim().slice(0, MAX_COMENTARIO) : null
  await tx`
    INSERT INTO nps_resposta (tenant_id, id, contato_id, atendente_id, nota, comentario, origem, respondido_em, criado_por)
    VALUES (tenant_atual(), ${npsId}, ${p.contatoId}, NULL, ${p.nota}, ${comentario}, 'agente', ${p.agora}, NULL)`
  if (!ehDetratorNps(p.nota)) return { npsId, detrator: false, tarefaId: null }

  // Presentes primeiro; ninguém presente → TODOS os gestores (B7): detrator não pode ficar sem ninguém avisado.
  const todos = await gestoresDoTenant(tx)
  const presentes = todos.filter((g) => !g.ausente)
  const gestores = presentes.length > 0 ? presentes : todos
  const tarefaId = randomUUID()
  await tx`
    INSERT INTO tarefa (tenant_id, id, contato_id, responsavel_id, titulo, descricao, vence_em, criado_por, tipo)
    VALUES (tenant_atual(), ${tarefaId}, ${p.contatoId}, ${gestores[0]?.id ?? null},
            ${`NPS detrator (nota ${p.nota}) — falar com o cliente`},
            ${`O cliente deu nota ${p.nota} na pesquisa do pós-venda feita pelo agente.${comentario ? `\n\nComentário: ${comentario}` : ''}`},
            ${p.agora}, NULL, 'whatsapp')`
  await notificarPessoasDaConversa(tx, gestores.map((g) => g.id), 'nps.detrator', `NPS detrator: nota ${p.nota}`, p.conversaId)
  return { npsId, detrator: true, tarefaId }
}
