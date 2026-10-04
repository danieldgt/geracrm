import { LlmClaudeFerramentas } from './claude-ferramentas.js'
import { LlmOpenRouterFerramentas } from './openrouter-ferramentas.js'
import { LlmSimulado } from './llm-simulado.js'
import { LlmFerramentasNaoImplementado, type PortaLlmFerramentas } from './porta-llm.js'

/**
 * Fábrica do modelo COM FERRAMENTAS a partir do ambiente (a chave é NOSSA, uma
 * só, em variável de ambiente — nunca por tenant).
 *
 *   IA_PROVEDOR = claude | openrouter | groq | gemini | simulado   (sem ele: a chave que existir, Claude primeiro)
 *   ANTHROPIC_API_KEY · OPENROUTER_API_KEY · GROQ_API_KEY · GEMINI_API_KEY
 *   IA_MODELO (lista separada por vírgula no OpenRouter; um modelo nos demais)
 *   IA_URL (opcional: outro endpoint OpenAI-compatível) · IA_TIMEOUT_MS (1 000–120 000)
 *
 * ⚠️ Sem orçamento para a Anthropic, a melhor opção GRATUITA com ferramentas é
 *    o Groq (llama-3.3-70b-versatile: 1 000 pedidos/dia sem cartão). No
 *    OpenRouter, use `openrouter/free` (o roteador filtra quem aceita
 *    ferramentas e saída estruturada) ou um modelo que declare tool calling.
 *
 * ⚠️ `simulado` é um vendedor de regras para teste e demonstração — recusado em
 * produção. ⚠️ OpenRouter é reserva de DISPONIBILIDADE, não de custo (ADR-023).
 */
/** Chave e modelo padrão de cada fornecedor OpenAI-compatível. */
const COMPAT = {
  openrouter: { chave: 'OPENROUTER_API_KEY', modeloPadrao: null },
  groq: { chave: 'GROQ_API_KEY', modeloPadrao: 'llama-3.3-70b-versatile' },
  gemini: { chave: 'GEMINI_API_KEY', modeloPadrao: 'gemini-2.5-flash' },
} as const

export function faltaParaLlmFerramentas(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const pedido = env.IA_PROVEDOR?.trim()
  if (pedido === 'simulado') return env.NODE_ENV === 'production' ? ['IA_PROVEDOR=simulado não é permitido em produção'] : []
  if (pedido === 'groq' || pedido === 'gemini') {
    return env[COMPAT[pedido].chave]?.trim() ? [] : [COMPAT[pedido].chave]
  }
  if (pedido === 'openrouter' || (!pedido && !env.ANTHROPIC_API_KEY?.trim() && env.OPENROUTER_API_KEY?.trim())) {
    const falta: string[] = []
    if (!env.OPENROUTER_API_KEY?.trim()) falta.push('OPENROUTER_API_KEY')
    if (!env.IA_MODELO?.trim()) falta.push('IA_MODELO')
    return falta
  }
  if (env.ANTHROPIC_API_KEY?.trim()) return []
  return ['ANTHROPIC_API_KEY (ou IA_PROVEDOR=simulado fora de produção)']
}

export function llmFerramentasDoAmbiente(env: NodeJS.ProcessEnv = process.env): PortaLlmFerramentas {
  const falta = faltaParaLlmFerramentas(env)
  if (falta.length) return new LlmFerramentasNaoImplementado(falta.join('; '))
  const pedido = env.IA_PROVEDOR?.trim()
  const bruto = Number(env.IA_TIMEOUT_MS)
  const timeoutMs = Number.isFinite(bruto) && bruto >= 1_000 && bruto <= 120_000 ? bruto : undefined
  if (pedido === 'simulado') return new LlmSimulado()
  if (pedido === 'groq' || pedido === 'gemini') {
    const c = COMPAT[pedido]
    return new LlmOpenRouterFerramentas({
      preset: pedido, apiKey: env[c.chave]!.trim(), timeoutMs,
      modelos: [env.IA_MODELO?.split(',')[0]?.trim() || c.modeloPadrao], url: env.IA_URL?.trim() || undefined,
    })
  }
  if (pedido === 'openrouter' || (!pedido && !env.ANTHROPIC_API_KEY?.trim())) {
    return new LlmOpenRouterFerramentas({ apiKey: env.OPENROUTER_API_KEY!.trim(), modelos: env.IA_MODELO!.split(','), timeoutMs, url: env.IA_URL?.trim() || undefined })
  }
  return new LlmClaudeFerramentas({ apiKey: env.ANTHROPIC_API_KEY!.trim(), modelo: env.IA_MODELO?.split(',')[0]?.trim() || undefined })
}
