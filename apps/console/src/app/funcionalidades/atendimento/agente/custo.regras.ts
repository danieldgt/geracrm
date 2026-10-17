import { reaisParaCentavos } from '../../../compartilhado/ui/dinheiro.js'

/**
 * Regras PURAS da tela de custo e tetos (ADR-032, raia P6) — sem Angular, para
 * o teste rodar em Node. Dinheiro sempre em centavos inteiros.
 */

/** Como a pessoa escolhe o teto por conversa. */
export type EscolhaTeto = 'padrao' | 'personalizado' | 'sem_teto'

export function escolhaDoTeto(teto: number | null): EscolhaTeto {
  return teto === null ? 'padrao' : teto === 0 ? 'sem_teto' : 'personalizado'
}

/**
 * A escolha da tela → o corpo do PUT. Devolve o erro em texto quando o valor
 * personalizado não é um valor em reais maior que zero.
 */
export function tetoParaSalvar(escolha: EscolhaTeto, texto: string): { ok: true; tetoSessaoCentavos: number | null } | { ok: false; erro: string } {
  if (escolha === 'padrao') return { ok: true, tetoSessaoCentavos: null }
  if (escolha === 'sem_teto') return { ok: true, tetoSessaoCentavos: 0 }
  const c = reaisParaCentavos(texto)
  if (c === null || c <= 0) return { ok: false, erro: 'Informe um valor em reais maior que zero, ex.: 2,50.' }
  return { ok: true, tetoSessaoCentavos: c }
}

/** Texto do orçamento → corpo do PUT. Vazio = sem orçamento (nenhum alerta). */
export function orcamentoParaSalvar(texto: string): { ok: true; mensalCentavos: number | null } | { ok: false; erro: string } {
  if (!texto.trim()) return { ok: true, mensalCentavos: null }
  const c = reaisParaCentavos(texto)
  if (c === null || c <= 0) return { ok: false, erro: 'Informe um valor em reais maior que zero, ou deixe em branco para não ter orçamento.' }
  return { ok: true, mensalCentavos: c }
}

/** Percentual usado do mês, inteiro e limitado a 100 na barra (o texto mostra o real). */
export function percentualDoMes(gasto: number, mensal: number | null): { real: number; barra: number } | null {
  if (mensal === null || mensal <= 0) return null
  const real = Math.floor((gasto * 100) / mensal)
  return { real, barra: Math.min(100, real) }
}
