import { calcularJanela, permiteTextoLivre } from '@geracrm/shared'
import type { ResultadoEnvio } from './porta.js'

/**
 * Gateway único de envio (E5-13).
 *
 * ⚠️ NENHUM envio de conteúdo sai sem passar por aqui. O gateway revalida no
 * SERVIDOR — não na tela — os guardrails, nesta ordem:
 *   1. opt-out / bloqueio (sobrevive a tudo: é o direito do destinatário);
 *   2. disparo pausado — ⚠️ só para envio PROGRAMÁTICO. Resposta de gente numa
 *      conversa aberta continua saindo: a pausa protege o número do tráfego em
 *      massa, e travar a resposta a quem escreveu seria parar o atendimento;
 *   3. estado do canal (suspenso/desconectado não envia; degradado ainda envia);
 *   4. credencial presente;
 *   5. janela de 24h — SÓ no canal oficial (Meta) e só fora de template. O
 *      não-oficial declara texto livre a qualquer hora (ADR-021), então não
 *      cai neste ramo.
 *
 * A decisão é PURA (`avaliarEnvio`) e o despacho entra por callback: assim o
 * guard sempre roda ANTES do adaptador, e o gateway é testável sem rede nem DB.
 * Recusa de guardrail é RETORNO TIPIFICADO, nunca exceção (CLAUDE.md): a tela
 * precisa do motivo nomeado para dar a ação corretiva.
 */

/** Recusa DECIDIDA POR NÓS, antes do fornecedor. Distinta de falha de transporte. */
export type MotivoRecusa =
  /** Disparo pausado neste canal (manual ou automático por queda de entrega). */
  | 'disparo_pausado'
  /** Destino em opt-out / lista de bloqueio. */
  | 'bloqueado'
  /** Canal suspenso ou desconectado — não dá para enviar agora. */
  | 'canal_indisponivel'
  /** Sem provedor/credencial configurada para este canal. */
  | 'canal_sem_credencial'
  /** Oficial, fora da janela de 24h e sem template aprovado. */
  | 'janela_fechada'

/** Tudo que o gateway precisa para decidir — nada de rede aqui. */
export interface ContextoEnvio {
  /**
   * ⚠️ Envio PROGRAMÁTICO (campanha, automação, resumo de pedido) × resposta de
   * uma pessoa numa conversa aberta. A distinção existe porque a pausa protege o
   * número contra tráfego em massa — travar a resposta a quem acabou de escrever
   * seria parar o atendimento para proteger a reputação de um número que só está
   * em risco por causa do tráfego em massa.
   */
  readonly ehDisparo?: boolean
  /** `canal_configuracao.disparo_pausado` — pausa manual ou automática. */
  readonly disparoPausado?: boolean
  readonly tipoCanal: string
  readonly estadoCanal: string
  readonly provedor: string | null
  readonly temCredencial: boolean
  readonly destinoBloqueado: boolean
  /** É um template aprovado? (reabre a janela no oficial) */
  readonly ehTemplate: boolean
  /** Última mensagem ENTRANTE do cliente — base da janela de 24h. */
  readonly ultimaEntranteEm: Date | null
}

export type ResultadoEnvioGateway =
  | { ok: true; idExterno: string }
  | { ok: false; classe: 'recusa'; motivo: MotivoRecusa }
  | { ok: false; classe: 'transporte'; motivo: string; detalhe?: string | undefined }

/**
 * Decisão pura: podemos enviar? A ordem é intencional — o opt-out vem primeiro
 * porque é o único que vale mesmo com o canal perfeito.
 */
export function avaliarEnvio(
  ctx: ContextoEnvio,
  agora: Date,
): { libera: true } | { libera: false; motivo: MotivoRecusa } {
  if (ctx.destinoBloqueado) return { libera: false, motivo: 'bloqueado' }
  // ⚠️ Logo depois do opt-out, e ANTES das checagens técnicas: a pausa é uma
  //    decisão NOSSA de proteção, e quem for ver o motivo precisa ler "disparo
  //    pausado", não "canal indisponível".
  if (ctx.ehDisparo && ctx.disparoPausado) return { libera: false, motivo: 'disparo_pausado' }
  if (ctx.estadoCanal === 'suspenso' || ctx.estadoCanal === 'desconectado') {
    return { libera: false, motivo: 'canal_indisponivel' }
  }
  if (!ctx.provedor || !ctx.temCredencial) return { libera: false, motivo: 'canal_sem_credencial' }
  // Janela: propriedade do canal oficial. Não-oficial = texto livre sempre.
  if (ctx.tipoCanal === 'whatsapp_oficial' && !ctx.ehTemplate) {
    const janela = calcularJanela(ctx.ultimaEntranteEm, agora)
    if (!permiteTextoLivre(janela)) return { libera: false, motivo: 'janela_fechada' }
  }
  return { libera: true }
}

/**
 * Porta única: avalia e só então despacha. Todo caminho de envio de conteúdo
 * chama isto — nunca o adaptador direto.
 */
export async function enviarPeloGateway(
  ctx: ContextoEnvio,
  agora: Date,
  despachar: () => Promise<ResultadoEnvio>,
): Promise<ResultadoEnvioGateway> {
  const decisao = avaliarEnvio(ctx, agora)
  if (!decisao.libera) return { ok: false, classe: 'recusa', motivo: decisao.motivo }

  const r = await despachar()
  if (r.ok) return { ok: true, idExterno: r.idExterno }
  return { ok: false, classe: 'transporte', motivo: r.motivo, detalhe: r.detalhe }
}
