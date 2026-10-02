import type { MotivoFalhaLlm } from './porta.js'

/**
 * A porta do MODELO COM FERRAMENTAS (ADR-023) — o que o vendedor precisa de um
 * LLM, definido por nós. Sucede `PortaLlm` (um turno, um envelope): aqui o
 * modelo pode chamar ferramentas do domínio em rodadas, e entrega no fim uma
 * saída estruturada que o domínio ainda valida.
 *
 * ⚠️ O modelo PROPÕE; o domínio decide. Nenhuma ferramenta aqui efetiva pedido,
 * dá desconto ou apaga nada — ferramentas são de menor privilégio por desenho.
 */

export interface CapacidadesLlmFerramentas {
  readonly ferramentas: boolean
  readonly saidaEstruturada: boolean
  /** Cache de prefixo (persona + políticas) — reduz custo e latência. */
  readonly cacheDePrefixo: boolean
}

/** Um bloco da instrução de sistema; `cachear` marca um ponto de cache. */
export interface BlocoSistema {
  readonly texto: string
  readonly cachear?: boolean
}

/**
 * Uma fala, do ponto de vista do domínio. `operador` é instrução NOSSA no meio
 * da conversa (modo, promoção ativa, estado do pedido) — vai como `system`
 * dentro das mensagens, que o cliente não consegue forjar.
 */
export interface MensagemLlm {
  readonly papel: 'cliente' | 'nos' | 'operador'
  readonly texto: string
}

export interface DefinicaoFerramentaLlm {
  readonly nome: string
  readonly descricao: string
  /** JSON Schema do objeto de entrada (additionalProperties: false). */
  readonly esquema: Record<string, unknown>
}

export type ResultadoExecucaoFerramenta =
  | { readonly ok: true; readonly saida: unknown }
  | { readonly ok: false; readonly erro: string }

export interface LimitesDoLaco {
  readonly maxRodadas: number
  readonly maxTokensSaida: number
  readonly prazoMs: number
}

export interface PedidoDeLaco {
  readonly sistema: readonly BlocoSistema[]
  readonly mensagens: readonly MensagemLlm[]
  readonly ferramentas: readonly DefinicaoFerramentaLlm[]
  /** Executa UMA ferramenta pelo nome. Nunca lança: erro vira `tool_result` de erro. */
  readonly executar: (nome: string, entrada: unknown) => Promise<ResultadoExecucaoFerramenta>
  /** JSON Schema da saída final (shared: respostaDoAgente). */
  readonly esquemaSaida: Record<string, unknown>
  readonly limites: LimitesDoLaco
  readonly modelo?: string | undefined
  readonly esforco?: 'low' | 'medium' | 'high' | undefined
}

export interface ChamadaRegistrada {
  readonly nome: string
  readonly entrada: unknown
  readonly saida: unknown
  readonly ms: number
  readonly erro?: string | undefined
}

export interface UsoDoLaco {
  readonly entrada: number
  readonly saida: number
  readonly cacheLeitura: number
  readonly cacheEscrita: number
}

export interface RastroDoLaco {
  readonly chamadas: readonly ChamadaRegistrada[]
  readonly rodadas: number
  readonly uso: UsoDoLaco
  readonly modelo: string
  readonly latenciaMs: number
  readonly parouPor: 'fim' | 'max_rodadas' | 'prazo' | 'max_tokens'
}

export type ResultadoLaco =
  | { readonly ok: true; readonly saida: unknown; readonly rastro: RastroDoLaco }
  | { readonly ok: false; readonly motivo: MotivoFalhaLlm; readonly detalhe?: string | undefined; readonly rastro?: RastroDoLaco | undefined }

export interface PortaLlmFerramentas {
  readonly nome: string
  readonly capacidades: CapacidadesLlmFerramentas
  rodar(pedido: PedidoDeLaco): Promise<ResultadoLaco>
}

/** Objeto nulo: provedor sem adaptador responde com falha NOMEADA, nunca lança. */
export class LlmFerramentasNaoImplementado implements PortaLlmFerramentas {
  readonly capacidades: CapacidadesLlmFerramentas = { ferramentas: false, saidaEstruturada: false, cacheDePrefixo: false }
  constructor(readonly nome: string) {}
  async rodar(): Promise<ResultadoLaco> {
    return { ok: false, motivo: 'credencial_invalida', detalhe: `Sem adaptador para ${this.nome}.` }
  }
}

/**
 * Custo ESTIMADO de um laço, em centavos de real — para o teto diário e o
 * painel. Tabela de preço por modelo (US$ por milhão de tokens) e câmbio do
 * ambiente. Estimativa, não fatura: a fatura é a do fornecedor.
 */
const PRECO_USD_POR_MILHAO: Record<string, { entrada: number; saida: number; cacheLeitura: number; cacheEscrita: number }> = {
  'claude-opus-5-5': { entrada: 4, saida: 20, cacheLeitura: 0.2, cacheEscrita: 5 },
  'claude-sonnet-5-5': { entrada: 2, saida: 10, cacheLeitura: 0.2, cacheEscrita: 2.5 },
  'claude-haiku-4-5': { entrada: 1, saida: 5, cacheLeitura: 0.1, cacheEscrita: 1.25 },
}

export function custoEstimadoCentavos(modelo: string, uso: UsoDoLaco, cambioBrl = Number(process.env.IA_CAMBIO_BRL) || 5.5): number {
  const chave = Object.keys(PRECO_USD_POR_MILHAO).find((k) => modelo.startsWith(k))
  const p = chave ? PRECO_USD_POR_MILHAO[chave]! : PRECO_USD_POR_MILHAO['claude-opus-5-5']!
  const usd = (uso.entrada * p.entrada + uso.saida * p.saida + uso.cacheLeitura * p.cacheLeitura + uso.cacheEscrita * p.cacheEscrita) / 1_000_000
  return Math.round(usd * cambioBrl * 100)
}
