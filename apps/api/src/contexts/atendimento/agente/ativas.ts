import { calcularJanela, contarVariaveis, lerConfigAtivas, normalizarFeriados, permiteTextoLivre, type ConfigAtivas } from '@geracrm/shared'
import type { Sql } from '../../../db/index.js'
import { proximaAbertura, situacaoDoExpediente, type HorarioAtendimento } from '../expediente.js'

/**
 * A POLÍTICA DAS MENSAGENS ATIVAS (raia P11; playbook da AM §2.5 e §5.2).
 *
 * Ativa = mensagem que NÓS iniciamos (o retorno do agente). Resposta a quem
 * acabou de escrever não passa por aqui — é 24/7.
 *
 * Ordem fixa (a primeira que barrar decide):
 *   1. ativas SUSPENSAS no número (qualidade/conta, webhook da Meta) → ADIA;
 *   2. fora do expediente ou feriado → ADIA para a próxima abertura;
 *   3. limite do dia/semana, contado desde a última mensagem do cliente → DESCARTA;
 *   4. OFICIAL fora da janela de 24h → TEMPLATE aprovado, ou RECUSA nomeada.
 *
 * ⚠️ Adiar não gasta tentativa: a mesma linha volta na hora certa. Descartar e
 *    recusar são finais — limite é teto, não fila (acumular para amanhã seria
 *    mandar a rajada que o limite existe para impedir).
 *
 * `decidirAtiva` é PURA; a leitura do banco fica em `lerContextoAtiva`.
 */

/** Suspensão não tem hora marcada para acabar: reolha a cada hora. */
export const ADIAMENTO_SUSPENSAS_MS = 60 * 60_000
/** Sem abertura nos próximos dias (todos fechados): reolha em um dia. */
export const ADIAMENTO_SEM_ABERTURA_MS = 24 * 60 * 60_000

export interface TemplateDaAtiva {
  readonly id: string
  /** Status da Meta da versão vigente (`APPROVED` se houver uma aprovada); `null` = template apagado. */
  readonly status: string | null
  readonly variaveis: number
}

export interface ContextoAtiva {
  readonly tipoCanal: string
  readonly suspensaDesde: Date | null
  readonly horario: HorarioAtendimento | null
  readonly feriados: readonly string[]
  readonly fuso: string
  readonly config: ConfigAtivas
  readonly ultimaEntranteEm: Date | null
  readonly enviadasDia: number
  readonly enviadasSemana: number
  readonly template: TemplateDaAtiva | null
}

export type DecisaoAtiva =
  | { readonly acao: 'texto' }
  | { readonly acao: 'template'; readonly templateId: string }
  | { readonly acao: 'adiar'; readonly ate: Date; readonly motivo: 'ativas_suspensas' | 'fora_do_expediente' | 'feriado' }
  | { readonly acao: 'descartar'; readonly motivo: 'limite_dia' | 'limite_semana' }
  | { readonly acao: 'recusar'; readonly motivo: 'sem_template' | 'template_indisponivel' | 'template_incompativel' }

export function decidirAtiva(c: ContextoAtiva, agora: Date): DecisaoAtiva {
  if (c.suspensaDesde) return { acao: 'adiar', ate: new Date(agora.getTime() + ADIAMENTO_SUSPENSAS_MS), motivo: 'ativas_suspensas' }

  const situacao = situacaoDoExpediente(c.horario, c.feriados, agora, c.fuso)
  if (situacao !== 'aberto') {
    const abre = proximaAbertura(c.horario, c.feriados, agora, c.fuso)
    return { acao: 'adiar', ate: abre ?? new Date(agora.getTime() + ADIAMENTO_SEM_ABERTURA_MS), motivo: situacao }
  }

  if (c.enviadasDia >= c.config.limiteDia) return { acao: 'descartar', motivo: 'limite_dia' }
  if (c.enviadasSemana >= c.config.limiteSemana) return { acao: 'descartar', motivo: 'limite_semana' }

  // Janela: propriedade do OFICIAL (ADR-021). O não-oficial envia texto livre.
  if (c.tipoCanal === 'whatsapp_oficial' && !permiteTextoLivre(calcularJanela(c.ultimaEntranteEm, agora))) {
    if (!c.config.templateRetorno) return { acao: 'recusar', motivo: 'sem_template' }
    if (!c.template || c.template.status !== 'APPROVED') return { acao: 'recusar', motivo: 'template_indisponivel' }
    if (c.template.variaveis > 1) return { acao: 'recusar', motivo: 'template_incompativel' }
    return { acao: 'template', templateId: c.template.id }
  }
  return { acao: 'texto' }
}

/**
 * Tudo que a decisão precisa, numa ida ao banco por bloco, sob RLS (tenant já
 * setado). `null` = conversa inexistente.
 *
 * ⚠️ Os limites contam as ativas ENVIADAS (`agente_retorno.estado = enviado`)
 *    desde a ÚLTIMA mensagem do cliente, dentro da janela do limite (24h para
 *    o dia, 7 dias para a semana): o cliente que responde zera a contagem.
 */
export async function lerContextoAtiva(
  tx: Sql, p: { conversaId: string; agora: Date },
): Promise<ContextoAtiva | null> {
  const [l] = await tx<{
    tipo: string; suspensa_desde: Date | null; horario: HorarioAtendimento | null; feriados: unknown
    fuso: string | null; ativas: unknown; ultima_entrante_em: Date | null; dia: number; semana: number
  }[]>`
    SELECT cc.tipo, cc.ativas_suspensas_em AS suspensa_desde,
           cfg.horario_atendimento AS horario, coalesce(cfg.feriados, '[]'::jsonb) AS feriados,
           t.fuso, coalesce(ac.ativas, '{}'::jsonb) AS ativas, c.ultima_entrante_em,
           (SELECT count(*)::int FROM agente_retorno r
             WHERE r.tenant_id = c.tenant_id AND r.conversa_id = c.id AND r.estado = 'enviado'
               AND r.concluido_em > greatest(coalesce(c.ultima_entrante_em, '-infinity'::timestamptz),
                                             ${p.agora}::timestamptz - interval '1 day')) AS dia,
           (SELECT count(*)::int FROM agente_retorno r
             WHERE r.tenant_id = c.tenant_id AND r.conversa_id = c.id AND r.estado = 'enviado'
               AND r.concluido_em > greatest(coalesce(c.ultima_entrante_em, '-infinity'::timestamptz),
                                             ${p.agora}::timestamptz - interval '7 days')) AS semana
      FROM conversa c
      JOIN canal_conectado cc ON cc.tenant_id = c.tenant_id AND cc.id = c.canal_id
      JOIN tenant t ON t.id = c.tenant_id
      LEFT JOIN canal_configuracao cfg ON cfg.tenant_id = c.tenant_id AND cfg.canal_id = cc.id
      LEFT JOIN agente_config ac ON ac.tenant_id = c.tenant_id AND ac.canal_id = cc.id
     WHERE c.tenant_id = tenant_atual() AND c.id = ${p.conversaId}`
  if (!l) return null

  const config = lerConfigAtivas(l.ativas)
  return {
    tipoCanal: l.tipo,
    suspensaDesde: l.suspensa_desde,
    horario: l.horario,
    feriados: normalizarFeriados(l.feriados),
    fuso: l.fuso ?? 'America/Sao_Paulo',
    config,
    ultimaEntranteEm: l.ultima_entrante_em,
    enviadasDia: l.dia,
    enviadasSemana: l.semana,
    template: config.templateRetorno ? await lerTemplate(tx, config.templateRetorno) : null,
  }
}

/** O template de retorno como está AGORA: a versão aprovada, ou a mais recente. */
export async function lerTemplate(tx: Sql, templateId: string): Promise<TemplateDaAtiva | null> {
  const [v] = await tx<{ status_meta: string; corpo: { body?: { texto?: string } } }[]>`
    SELECT tv.status_meta, tv.corpo
      FROM template_versao tv
     WHERE tv.tenant_id = tenant_atual() AND tv.template_id = ${templateId}
     ORDER BY (tv.status_meta = 'APPROVED') DESC, tv.versao DESC
     LIMIT 1`
  if (!v) return { id: templateId, status: null, variaveis: 0 }
  return { id: templateId, status: v.status_meta, variaveis: contarVariaveis(v.corpo?.body?.texto ?? '') }
}
