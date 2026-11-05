/**
 * Regras puras da aba "Por nº de pedidos" (Base de clientes).
 *
 * ⚠️ A API devolve seis baldes; dois são QUALIFICAÇÃO (leads sem compra e
 * descartados), que desde 2026-11-05 mora só no Funil (aba Qualificação).
 * Mostrar aqui de novo era ter dois lugares mudando a mesma coisa.
 */
export function colunaDeFrequencia(chave: string): boolean {
  return chave !== 'leads' && chave !== 'descartados'
}
