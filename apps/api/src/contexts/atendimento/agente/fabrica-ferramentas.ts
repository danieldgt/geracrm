import { LlmClaudeFerramentas } from './claude-ferramentas.js'
import { LlmOpenRouterFerramentas } from './openrouter-ferramentas.js'
import { LlmSimulado } from './llm-simulado.js'
import { LlmFerramentasNaoImplementado, type PortaLlmFerramentas } from './porta-llm.js'

/**
 * Fábrica do modelo COM FERRAMENTAS a partir do ambiente (a chave é NOSSA, uma
 * só, em variável de ambiente — nunca por tenant).
 *
 *   IA_PROVEDOR = claude | openrouter | simulado   (sem ele: a chave que existir, Claude primeiro)
 *   ANTHROPIC_API_KEY · OPENROUTER_API_KEY · IA_MODELO (lista separada por vírgula)
 *   IA_TIMEOUT_MS (opcional, 1 000–120 000)
 *
 * ⚠️ `simulado` é um vendedor de regras para teste e demonstração — recusado em
 * produção. ⚠️ OpenRouter é reserva de DISPONIBILIDADE, não de custo (ADR-023).
 */
export function faltaParaLlmFerramentas(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const pedido = env.IA_PROVEDOR?.trim()
  if (pedido === 'simulado') return env.NODE_ENV === 'production' ? ['IA_PROVEDOR=simulado não é permitido em produção'] : []
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
  if (pedido === 'openrouter' || (!pedido && !env.ANTHROPIC_API_KEY?.trim())) {
    return new LlmOpenRouterFerramentas({ apiKey: env.OPENROUTER_API_KEY!.trim(), modelos: env.IA_MODELO!.split(','), timeoutMs })
  }
  return new LlmClaudeFerramentas({ apiKey: env.ANTHROPIC_API_KEY!.trim(), modelo: env.IA_MODELO?.split(',')[0]?.trim() || undefined })
}
