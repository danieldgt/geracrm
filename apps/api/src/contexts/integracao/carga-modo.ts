/**
 * HISTÓRICO ou INCREMENTAL — a decisão que evita varrer o ERP do cliente quatro
 * vezes por dia.
 *
 * ⚠️ O integrador roda de 6 em 6 horas e a ingestão NÃO é incremental por
 * natureza: ela pede clientes, produtos e vendas `desde` uma data e faz upsert.
 * Enquanto havia teto de páginas isso era uma amostra barata. Tirar o teto sem
 * mudar mais nada transformaria cada ciclo numa varredura completa da base — no
 * sistema de onde o cliente fatura.
 *
 * Então: a primeira carga é HISTÓRICA (sem teto, desde o começo) e deixa recibo;
 * as seguintes são INCREMENTAIS (janela curta). Regra pura, testável, longe do
 * script que fala com a rede.
 */

export type ModoCarga = 'historico' | 'incremental'

export interface DecisaoCarga {
  readonly modo: ModoCarga
  /** Data a partir da qual pedir as vendas. */
  readonly desde: Date
  /** `undefined` = sem teto (base inteira). */
  readonly maxPaginas: number | undefined
  /** Por que este modo — vai para o log, que é onde alguém vai procurar. */
  readonly motivo: string
}

export interface EntradaDecisao {
  /** Já existe recibo de carga histórica para esta conexão? */
  readonly temRecibo: boolean
  /** `DESDE` do ambiente — o começo do histórico. */
  readonly desdeHistorico: Date
  /** Dias da janela incremental. */
  readonly diasIncremental: number
  /** `MAX_PAGINAS` do ambiente. 0 ou ausente = sem teto. */
  readonly maxPaginasEnv: number
  /** `FORCAR_HISTORICO=1` — refazer mesmo com recibo. */
  readonly forcarHistorico: boolean
  readonly agora: Date
}

export function decidirCarga(e: EntradaDecisao): DecisaoCarga {
  const teto = e.maxPaginasEnv > 0 ? e.maxPaginasEnv : undefined

  if (e.forcarHistorico || !e.temRecibo) {
    return {
      modo: 'historico',
      desde: e.desdeHistorico,
      maxPaginas: teto,
      motivo: e.forcarHistorico
        ? 'FORCAR_HISTORICO=1 — refazendo a carga completa'
        : 'sem recibo de carga histórica para esta conexão',
    }
  }

  return {
    modo: 'incremental',
    // ⚠️ Janela contada para trás a partir de agora. Sobreposição é de propósito:
    //    a ingestão é idempotente por identidade externa, e perder uma venda na
    //    fronteira do ciclo custa mais caro do que reprocessar algumas.
    desde: new Date(e.agora.getTime() - e.diasIncremental * 86_400_000),
    maxPaginas: teto,
    motivo: `histórico já carregado — janela de ${e.diasIncremental} dias`,
  }
}

/**
 * ⚠️ A carga só vira recibo se rodou SEM TETO. Uma carga truncada que se
 * declarasse concluída é o pior resultado possível: o produto passaria a operar
 * em modo incremental sobre um histórico pela metade, e o RFV mentiria em
 * silêncio para sempre — sem nenhum erro em lugar nenhum.
 */
export function podeMarcarConcluida(d: DecisaoCarga): boolean {
  return d.modo === 'historico' && d.maxPaginas === undefined
}
