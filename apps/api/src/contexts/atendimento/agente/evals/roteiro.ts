import type { MotivoFalhaLlm } from '../porta.js'
import type {
  ChamadaRegistrada, PedidoDeLaco, PortaLlmFerramentas, ResultadoExecucaoFerramenta, ResultadoLaco, UsoDoLaco,
} from '../porta-llm.js'

/**
 * MODELOS DE TESTE dos evals — atrás da MESMA porta do Claude, para o pipeline
 * rodar inteiro (portão → gatilhos → ferramentas REAIS → guardrails → envio →
 * auditoria) com uma saída conhecida do modelo.
 *
 *   - `LlmRoteirizado`: executa um roteiro (chama ferramentas de verdade pelo
 *     registro do turno e devolve as mensagens que o roteiro montou). É como os
 *     cenários forçam o comportamento ERRADO que um guardrail precisa pegar
 *     ("15% de desconto" sem fonte, "garantimos a entrega amanhã", pergunta
 *     repetida) — e como escrevem a resposta CERTA de um caso que o
 *     `LlmSimulado` não cobre (grade, recompra, sem estoque).
 *   - `LlmQueFalha`: o provedor falha com um motivo nomeado (transitória, fatal).
 */

export interface SaidaRoteiro {
  readonly mensagens: readonly string[]
  readonly confianca?: number | undefined
  readonly handoff?: { readonly motivo: string; readonly resumo: string } | undefined
}

export interface PassoRoteiro {
  /** Chama uma ferramenta do turno pelo registro real (preço, estoque, pedido de verdade). */
  readonly chamar: (nome: string, entrada: unknown) => Promise<ResultadoExecucaoFerramenta>
  /** O que o cliente escreveu por último. */
  readonly cliente: string
}

export type Roteiro = (p: PassoRoteiro) => Promise<SaidaRoteiro> | SaidaRoteiro

/** Uso/modelo declarados pelo roteiro (custo do turno sai pelo catálogo `modelo_ia`). */
export interface CustoRoteiro {
  readonly provedor: string
  readonly modelo: string
  readonly uso: UsoDoLaco
}

const SEM_USO: UsoDoLaco = { entrada: 0, saida: 0, cacheLeitura: 0, cacheEscrita: 0 }

export class LlmRoteirizado implements PortaLlmFerramentas {
  readonly nome = 'roteiro'
  readonly capacidades = { ferramentas: true, saidaEstruturada: true, cacheDePrefixo: false }
  /** Quantas vezes o modelo foi chamado (gatilho pré-LLM não chama). */
  chamadas = 0

  constructor(private readonly roteiro: Roteiro, private readonly custo?: CustoRoteiro | undefined) {}

  async rodar(p: PedidoDeLaco): Promise<ResultadoLaco> {
    this.chamadas += 1
    const inicio = Date.now()
    const registradas: ChamadaRegistrada[] = []
    const chamar = async (nome: string, entrada: unknown) => {
      const t0 = Date.now()
      const r = await p.executar(nome, entrada)
      registradas.push({ nome, entrada, saida: r.ok ? r.saida : null, ms: Date.now() - t0, ...(r.ok ? {} : { erro: r.erro }) })
      return r
    }
    const clientes = p.mensagens.filter((m) => m.papel === 'cliente')
    const s = await this.roteiro({ chamar, cliente: clientes[clientes.length - 1]?.texto ?? '' })
    return {
      ok: true,
      saida: { mensagens: [...s.mensagens], confianca: s.confianca ?? 0.9, ...(s.handoff ? { handoff: s.handoff } : {}) },
      rastro: {
        chamadas: registradas, rodadas: registradas.length + 1, uso: this.custo?.uso ?? SEM_USO,
        modelo: this.custo?.modelo ?? 'simulado', provedor: this.custo?.provedor ?? 'simulado',
        latenciaMs: Date.now() - inicio, parouPor: 'fim',
      },
    }
  }
}

export class LlmQueFalha implements PortaLlmFerramentas {
  readonly nome = 'falha'
  readonly capacidades = { ferramentas: true, saidaEstruturada: true, cacheDePrefixo: false }
  chamadas = 0

  constructor(private readonly motivo: MotivoFalhaLlm, private readonly detalhe = 'falha simulada pelo eval') {}

  async rodar(): Promise<ResultadoLaco> {
    this.chamadas += 1
    return { ok: false, motivo: this.motivo, detalhe: this.detalhe }
  }
}

/** Conta as chamadas de qualquer porta (o modelo real e o simulado não contam sozinhos). */
export class LlmContado implements PortaLlmFerramentas {
  chamadas = 0
  constructor(private readonly porta: PortaLlmFerramentas) {}
  get nome(): string { return this.porta.nome }
  get capacidades() { return this.porta.capacidades }
  async rodar(p: PedidoDeLaco): Promise<ResultadoLaco> {
    this.chamadas += 1
    return this.porta.rodar(p)
  }
}

// ── ajudantes de roteiro ────────────────────────────────────────────────────

export interface SkuBuscado {
  readonly skuId: string
  readonly atributos: Readonly<Record<string, string>>
  readonly precoCentavos: number | null
  readonly saldo: number | null | 'desconhecido'
}
export interface ProdutoBuscado { readonly produto: string; readonly skus: readonly SkuBuscado[] }

/** Itens da saída de `catalogo_buscar` (vazio se falhou). */
export function itensDaBusca(r: ResultadoExecucaoFerramenta): readonly ProdutoBuscado[] {
  if (!r.ok) return []
  return ((r.saida as { itens?: ProdutoBuscado[] }).itens ?? [])
}

/** O SKU cujos atributos têm EXATAMENTE os valores pedidos (sem acento/caixa). */
export function skuCom(p: ProdutoBuscado | undefined, atributos: Readonly<Record<string, string>>): SkuBuscado | undefined {
  const n = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
  return p?.skus.find((s) => Object.entries(atributos).every(([k, v]) => n(String(s.atributos[k] ?? '')) === n(v)))
}

export function brl(centavos: number): string {
  return `R$ ${(centavos / 100).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`
}
