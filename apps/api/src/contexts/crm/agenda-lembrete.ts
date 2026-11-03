import { randomUUID } from 'node:crypto'
import { comTenantServico, type Sql } from '../../db/index.js'
import { fusoSeguro } from '../plataforma/fuso.js'
import { moduloAtivo } from '../plataforma/modulos.js'

/**
 * LEMBRETE DE EVENTO DA AGENDA (raia C2) — agendado em `server.ts` (a cada 60 s, com guarda).
 *
 * Cada passada, como DONO acha os eventos AGENDADOS cujo `inicio - lembrete_min` já passou e que
 * ainda não avisaram; para cada um, SOB O TENANT, marca `lembrete_enviado_em` e cria a notificação
 * do sino para o responsável. Idempotente: a marca é um `UPDATE … WHERE lembrete_enviado_em IS NULL
 * RETURNING`, na mesma transação da notificação — duas passadas (ou duas instâncias) nunca avisam
 * em dobro. Tempo real: o evento `notificacao.nova` vai no outbox, SEM conteúdo (ADR-007).
 *
 * ⚠️ Módulo desligado = sem lembrete (e sem marca: ligado de novo, o aviso ainda vale se o evento
 *    não passou). Evento que já terminou sem avisar (servidor parado) é só marcado, não notificado.
 */
export const INTERVALO_LEMBRETE_AGENDA_MS = 60_000
const LOTE = 200

export interface RelatorioLembreteAgenda { readonly avisados: number; readonly descartados: number }

export async function enviarLembretesAgenda(
  dono: Sql, agora: Date = new Date(), deps: { somenteTenant?: string } = {},
): Promise<RelatorioLembreteAgenda> {
  const so = deps.somenteTenant
  // Perdeu a hora: o evento já acabou e ninguém foi avisado. Marca para sair do índice parcial.
  const velhos = await dono<{ id: string }[]>`
    UPDATE evento_agenda SET lembrete_enviado_em = ${agora}
     WHERE status = 'agendado' AND lembrete_min IS NOT NULL AND lembrete_enviado_em IS NULL AND fim <= ${agora}
       AND ${so ? dono`tenant_id = ${so}` : dono`true`}
    RETURNING id`
  const candidatos = await dono<{ tenant_id: string; id: string }[]>`
    SELECT tenant_id, id FROM evento_agenda
     WHERE status = 'agendado' AND lembrete_min IS NOT NULL AND lembrete_enviado_em IS NULL
       AND fim > ${agora} AND inicio - make_interval(mins => lembrete_min) <= ${agora}
       AND ${so ? dono`tenant_id = ${so}` : dono`true`}
     ORDER BY inicio LIMIT ${LOTE}`
  let avisados = 0
  for (const c of candidatos) {
    const ok = await comTenantServico(c.tenant_id, (tx) => avisar(tx, c.id, agora))
    if (ok) avisados++
  }
  return { avisados, descartados: velhos.length }
}

async function avisar(tx: Sql, id: string, agora: Date): Promise<boolean> {
  if (!(await moduloAtivo(tx, 'agenda'))) return false
  const [e] = await tx<{ titulo: string; responsavel_id: string; inicio: Date }[]>`
    UPDATE evento_agenda SET lembrete_enviado_em = ${agora}
     WHERE tenant_id = tenant_atual() AND id = ${id} AND status = 'agendado' AND lembrete_enviado_em IS NULL
    RETURNING titulo, responsavel_id, inicio`
  if (!e) return false
  const [t] = await tx<{ fuso: string | null }[]>`SELECT fuso FROM tenant WHERE id = tenant_atual()`
  const hora = new Intl.DateTimeFormat('pt-BR', { timeZone: fusoSeguro(t?.fuso), hour: '2-digit', minute: '2-digit' }).format(e.inicio)
  await tx`
    INSERT INTO notificacao (tenant_id, id, usuario_id, tipo, titulo)
    VALUES (tenant_atual(), ${randomUUID()}, ${e.responsavel_id}, 'agenda.lembrete', ${`${e.titulo} — às ${hora}`})`
  await tx`
    INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id, payload)
    VALUES (tenant_atual(), 'notificacao.nova', 'usuario', ${e.responsavel_id},
            ${JSON.stringify({ usuarioId: e.responsavel_id })}::text::jsonb)`
  return true
}
