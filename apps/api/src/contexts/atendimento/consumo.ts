import { cambioBrl } from './agente/custo.js'
import { diasDoMes } from '@geracrm/shared'

/**
 * CONSUMO (F2): regras PURAS da tela de Consumo — preço do WhatsApp por categoria,
 * projeção do mês e alerta contra o orçamento. Tudo em centavos inteiros.
 */

export const CATEGORIAS_WHATSAPP = ['marketing', 'utility', 'authentication', 'service'] as const
export type CategoriaWhatsapp = (typeof CATEGORIAS_WHATSAPP)[number]

/** Padrão quando o tenant não definiu preço (aproximação da tabela BR da Meta; "service" é grátis). */
export const PRECO_PADRAO_CENTAVOS: Readonly<Record<CategoriaWhatsapp, number>> = {
  marketing: 35, utility: 4, authentication: 18, service: 0,
}
export const CAMBIO_PADRAO_MILESIMOS = 5500

export function ehCategoria(c: unknown): c is CategoriaWhatsapp {
  return typeof c === 'string' && (CATEGORIAS_WHATSAPP as readonly string[]).includes(c)
}

/** 'YYYY-MM' válido (mês 01-12)? */
export function mesValido(m: unknown): m is string {
  return typeof m === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(m)
}

/** Primeiro dia do mês e do mês seguinte ('YYYY-MM-DD') e quantos dias o mês tem. */
export function limitesDoMes(mes: string): { inicio: string; fim: string; dias: number } {
  const [a, m] = mes.split('-').map(Number) as [number, number]
  const prox = m === 12 ? `${a + 1}-01` : `${a}-${String(m + 1).padStart(2, '0')}`
  return { inicio: `${mes}-01`, fim: `${prox}-01`, dias: diasDoMes(mes) }
}

export function custoWhatsapp(mensagens: number, centavosPorMensagem: number): number {
  return mensagens * centavosPorMensagem
}

/**
 * Custo da transcrição: segundos × US$/hora × câmbio. Estimativa — a fatura é a do fornecedor.
 * US$/hora vem do ambiente (`TRANSCRICAO_USD_POR_HORA`, padrão 0,04 = Whisper turbo da Groq).
 */
export function custoTranscricao(segundos: number, env: NodeJS.ProcessEnv = process.env): number {
  const usdHora = Number(env.TRANSCRICAO_USD_POR_HORA ?? 0.04)
  const valor = Number.isFinite(usdHora) && usdHora >= 0 ? usdHora : 0.04
  return Math.round((segundos / 3600) * valor * cambioBrl(env) * 100)
}

/** Preços efetivos por categoria: o que o tenant gravou, senão o padrão. */
export function precosEfetivos(linhas: readonly { categoria: string; centavos: number }[]): Record<CategoriaWhatsapp, number> {
  const r = { ...PRECO_PADRAO_CENTAVOS }
  for (const l of linhas) if (ehCategoria(l.categoria)) r[l.categoria] = l.centavos
  return r
}
