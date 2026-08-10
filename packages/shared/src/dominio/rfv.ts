/**
 * Classificação RFV de um contato — a regra que diz "onde ele está no ciclo de
 * recompra".
 *
 * ⚠️ Vive em `packages/shared` (TS puro) porque é REGRA DE NEGÓCIO: o console
 * apenas apresenta, e a API e o app precisam da mesma classificação. Duplicar
 * isso na tela faria o segmento divergir entre web e mobile no primeiro ajuste.
 *
 * ⚠️ O sinal central é o `atrasoRelativo` — quanto o cliente passou do PRÓPRIO
 * ritmo (RFV-10), não de uma média geral. Quem compra a cada 90 dias não está
 * atrasado aos 60; uma régua única erraria os dois extremos. É a predição
 * explicável: dá para dizer à vendedora POR QUE aquele cliente subiu na fila.
 */

/** Chaves iguais às da rampa em `design-tokens` (`rfv.*`) — a cor sai de lá. */
export type CodigoSegmentoRfv =
  | 'cliente-recente'
  | 'cliente-fiel'
  | 'nao-perder'
  | 'em-risco'
  | 'semi-perdido'
  | 'hibernando'

export interface SegmentoRfv {
  readonly codigo: CodigoSegmentoRfv
  readonly rotulo: string
  /**
   * O que fazer — curto e acionável. A tela mostra ao lado do segmento; sem
   * isto, "em risco" vira um rótulo bonito que ninguém sabe o que fazer com.
   */
  readonly acao: string
  /**
   * ⚠️ Urgência para ORDENAR a fila (maior = age antes). Não é enfeite: é o que
   * põe "atrasado e valioso" no topo do dia da vendedora. Recente e fiel ficam
   * embaixo — não precisam de ação hoje.
   */
  readonly urgencia: number
}

export interface MetricasRfv {
  readonly qtdVendas: number
  readonly diasSemComprar: number | null
  /** Razão vs ritmo próprio. `null` quando há < 2 compras (sem ritmo ainda). */
  readonly atrasoRelativo: number | null
}

/**
 * ⚠️ Fronteiras nomeadas, não números soltos no meio do código. Ajustar a
 * régua do RFV é decisão de negócio; ela precisa estar num lugar só, à vista.
 */
const LIMITE = {
  /** Até aqui, comprou dentro do ritmo dele. */
  emDia: 0.9,
  /** Chegou o momento típico da próxima compra. */
  naHora: 1.4,
  /** Passou do ritmo — atenção. */
  atrasado: 2.5,
  /** Muito além — risco alto. */
  sumindo: 5,
  /** Contato de 1 compra ainda é "recente" abaixo disto (dias). */
  recenteDias: 60,
} as const

export function classificarRfv(m: MetricasRfv): SegmentoRfv {
  // ⚠️ Sem ritmo (1 compra só): não dá para falar em "atraso". Classifica por
  //    recência absoluta — e assume o menos alarmista possível, porque inventar
  //    urgência sobre quem mal começou queima a relação.
  if (m.atrasoRelativo === null) {
    if (m.diasSemComprar !== null && m.diasSemComprar <= LIMITE.recenteDias) {
      return seg('cliente-recente', 'Cliente novo', 'Fazer a segunda venda acontecer.', 20)
    }
    return seg('em-risco', 'Primeira compra parada', 'Reaproximar antes que esfrie de vez.', 60)
  }

  const a = m.atrasoRelativo
  if (a <= LIMITE.emDia) return seg('cliente-fiel', 'Em dia', 'Está comprando no ritmo — manter.', 10)
  if (a <= LIMITE.naHora) return seg('nao-perder', 'Na hora da recompra', 'Momento certo de falar com ele.', 50)
  if (a <= LIMITE.atrasado) return seg('em-risco', 'Atrasado', 'Passou do ritmo dele — procurar hoje.', 70)
  if (a <= LIMITE.sumindo) return seg('semi-perdido', 'Sumindo', 'Bem atrasado — risco de perder.', 85)
  return seg('hibernando', 'Hibernando', 'Muito além do ritmo — resgate ou deixar ir.', 95)
}

function seg(codigo: CodigoSegmentoRfv, rotulo: string, acao: string, urgencia: number): SegmentoRfv {
  return { codigo, rotulo, acao, urgencia }
}
