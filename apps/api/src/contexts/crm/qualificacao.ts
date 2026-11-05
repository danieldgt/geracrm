import type { Sql } from '../../db/index.js'
import { auditar } from '../plataforma/auditoria.js'

/**
 * A QUALIFICAÇÃO DO LEAD (CTT-05) — o único caminho de domínio que muda
 * `contato.qualificado`. Usado pelo arrastar do kanban (`rotas-leads`) e pelo
 * sistema (descarte após a cadência, reabertura quando o cliente volta — raia G5).
 *
 *   novo        = qualificado NULL      descartado = qualificado false
 *   qualificado = qualificado true
 *
 * ⚠️ CHECK `contato_qualificacao_coerente`: `qualificado` e `qualificado_em`
 *    andam juntos — 'novo' zera os dois. `descarte_motivo` só vale em descartado.
 * ⚠️ O ATOR vai para a auditoria: `atorId` null = o SISTEMA (agente), nunca um
 *    usuário que não clicou em nada.
 */
export type EstadoQualificacao = 'novo' | 'qualificado' | 'descartado'
export type MotivoDescarte = 'sem_resposta'

export interface QualificarContato {
  readonly contatoId: string
  readonly estado: EstadoQualificacao
  /** Só com `descartado`. Ausente = descarte manual. */
  readonly motivo?: MotivoDescarte | undefined
  /** Quem mudou; `null` = sistema. */
  readonly atorId: string | null
  readonly atorStaff?: boolean | undefined
  /** Relógio da mudança (injetável); padrão agora. */
  readonly em?: Date | undefined
  /** Só muda se o estado ATUAL for este (trava de corrida do sistema contra a mão do usuário). */
  readonly somenteSeEstava?: EstadoQualificacao | undefined
  /** Ação de auditoria; padrão `contato.qualificacao_alterada`. */
  readonly acao?: string | undefined
}

export type ResultadoQualificar =
  | { readonly tipo: 'ok'; readonly de: EstadoQualificacao }
  | { readonly tipo: 'nao_encontrado' }
  | { readonly tipo: 'estado_mudou'; readonly atual: EstadoQualificacao }

const estadoDe = (q: boolean | null): EstadoQualificacao => (q === null ? 'novo' : q ? 'qualificado' : 'descartado')

/** Chamar DENTRO da transação do chamador (tenant já setado). */
export async function qualificarContato(tx: Sql, p: QualificarContato): Promise<ResultadoQualificar> {
  const [atual] = await tx<{ qualificado: boolean | null }[]>`
    SELECT qualificado FROM contato
     WHERE tenant_id = tenant_atual() AND id = ${p.contatoId} AND ativo
       FOR UPDATE`
  if (!atual) return { tipo: 'nao_encontrado' }
  const de = estadoDe(atual.qualificado)
  if (p.somenteSeEstava && de !== p.somenteSeEstava) return { tipo: 'estado_mudou', atual: de }

  const q = p.estado === 'qualificado' ? true : p.estado === 'descartado' ? false : null
  const motivo = p.estado === 'descartado' ? (p.motivo ?? null) : null
  const em = p.em ?? new Date()
  await tx`
    UPDATE contato
       SET qualificado = ${q},
           qualificado_em = ${q === null ? null : em},
           descarte_motivo = ${motivo}
     WHERE tenant_id = tenant_atual() AND id = ${p.contatoId}`
  await auditar(tx, {
    atorId: p.atorId, atorStaff: p.atorStaff ?? false,
    acao: p.acao ?? 'contato.qualificacao_alterada', entidade: 'contato', entidadeId: p.contatoId,
    dados: { de, para: p.estado, motivo, origem: p.atorId ? 'usuario' : 'sistema' },
  })
  return { tipo: 'ok', de }
}
