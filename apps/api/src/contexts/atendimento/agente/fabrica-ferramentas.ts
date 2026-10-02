import { LlmClaudeFerramentas } from './claude-ferramentas.js'
import { LlmSimulado } from './llm-simulado.js'
import { LlmFerramentasNaoImplementado, type PortaLlmFerramentas } from './porta-llm.js'

/**
 * Fábrica do modelo COM FERRAMENTAS a partir do ambiente (mesma filosofia de
 * `fabrica.ts`: a chave é NOSSA, uma só, em variável de ambiente).
 *
 *   IA_PROVEDOR = claude | simulado | openrouter
 *   ANTHROPIC_API_KEY, IA_MODELO (opcional), IA_TIMEOUT_MS (opcional)
 *
 * ⚠️ `simulado` é recusado em produção: é um vendedor de regras para teste e
 * demonstração, não para cliente real.
 * ⚠️ OpenRouter ainda não tem laço de ferramentas aqui — declara-se
 * indisponível com a frase que diz o que fazer, em vez de rodar sem catálogo.
 */
export function faltaParaLlmFerramentas(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const pedido = env.IA_PROVEDOR?.trim()
  if (pedido === 'simulado') return env.NODE_ENV === 'production' ? ['IA_PROVEDOR=simulado não é permitido em produção'] : []
  if (pedido === 'openrouter') return ['OpenRouter ainda sem laço de ferramentas — use ANTHROPIC_API_KEY (IA_PROVEDOR=claude)']
  if (env.ANTHROPIC_API_KEY?.trim()) return []
  return ['ANTHROPIC_API_KEY (ou IA_PROVEDOR=simulado fora de produção)']
}

export function llmFerramentasDoAmbiente(env: NodeJS.ProcessEnv = process.env): PortaLlmFerramentas {
  const falta = faltaParaLlmFerramentas(env)
  if (falta.length) return new LlmFerramentasNaoImplementado(falta.join('; '))
  if (env.IA_PROVEDOR?.trim() === 'simulado') return new LlmSimulado()
  return new LlmClaudeFerramentas({ apiKey: env.ANTHROPIC_API_KEY!.trim(), modelo: env.IA_MODELO?.split(',')[0]?.trim() || undefined })
}
