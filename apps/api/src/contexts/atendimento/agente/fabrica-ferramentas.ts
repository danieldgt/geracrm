import { LlmClaudeFerramentas, MODELO_PADRAO as MODELO_PADRAO_CLAUDE } from './claude-ferramentas.js'
import { LlmOpenRouterFerramentas } from './openrouter-ferramentas.js'
import { LlmSimulado } from './llm-simulado.js'
import { LlmFerramentasNaoImplementado, type PortaLlmFerramentas } from './porta-llm.js'
import { RoteadorLlm, type LadoLlm } from './llm-reserva.js'
import { JANELA_RESERVA_PADRAO_MS } from './llm-estado.js'

/**
 * Fábrica do modelo COM FERRAMENTAS a partir do ambiente (a chave é NOSSA, uma
 * só, em variável de ambiente — nunca por tenant).
 *
 *   IA_PROVEDOR = claude | openrouter | groq | gemini | simulado   (sem ele: a chave que existir, Claude primeiro)
 *   ANTHROPIC_API_KEY · OPENROUTER_API_KEY · GROQ_API_KEY · GEMINI_API_KEY
 *   IA_MODELO (lista separada por vírgula no OpenRouter; um modelo nos demais)
 *   IA_URL (opcional: outro endpoint OpenAI-compatível) · IA_TIMEOUT_MS (1 000–120 000)
 *
 * RESERVA DE PROVEDOR (ADR-030) — opcional, mas pré-requisito de produção:
 *   IA_RESERVA_PROVEDOR = claude | openrouter | groq | gemini | cerebras | maritaca
 *   IA_RESERVA_MODELO   (padrão do fornecedor; obrigatório no openrouter)
 *   IA_RESERVA_JANELA_MIN = 30   (1–1440: quanto tempo a reserva fica ligada)
 * Todo modelo real sai embrulhado no `RoteadorLlm` (`llm-reserva.ts`): 403/404
 * num modelo do catálogo cai no `IA_MODELO`; 2 falhas de provedor seguidas
 * ligam a reserva. ⚠️ A chave da reserva precisa estar no ambiente MESMO sem
 * usar — ela só é lida no dia em que o principal cair.
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
  cerebras: { chave: 'CEREBRAS_API_KEY', modeloPadrao: 'llama-3.3-70b' },
  maritaca: { chave: 'MARITACA_API_KEY', modeloPadrao: 'sabia-3.1' },
} as const
export type ProvedorLlm = 'claude' | keyof typeof COMPAT

/** A variável de ambiente que falta para um fornecedor — ou null se está pronto. */
export function chaveQueFalta(provedor: ProvedorLlm, env: NodeJS.ProcessEnv = process.env): string | null {
  const nome = provedor === 'claude' ? 'ANTHROPIC_API_KEY' : COMPAT[provedor].chave
  return env[nome]?.trim() ? null : nome
}

/**
 * O modelo de UMA entrada do catálogo (`modelo_ia`): o cliente escolheu o
 * modelo; a chave é a nossa, do ambiente. Fornecedor sem chave devolve o objeto
 * nulo com o nome da variável — a tela já mostrou isso como indisponível.
 * Sai no roteador: 403/404 neste modelo cai no `IA_MODELO`; queda do
 * fornecedor liga a reserva.
 */
export function criarLlmDoCatalogo(
  entrada: { provedor: ProvedorLlm; modelo: string }, env: NodeJS.ProcessEnv = process.env,
): PortaLlmFerramentas {
  return new RoteadorLlm({
    principal: { porta: adaptadorDoCatalogo(entrada, env), modelo: entrada.modelo },
    padrao: padraoDoAmbiente(env) ?? undefined,
    reserva: reservaDoAmbiente(env) ?? undefined,
    janelaMs: janelaDaReservaMs(env),
  })
}

/** O adaptador CRU de uma entrada do catálogo (sem roteador). */
function adaptadorDoCatalogo(entrada: { provedor: ProvedorLlm; modelo: string }, env: NodeJS.ProcessEnv): PortaLlmFerramentas {
  const falta = chaveQueFalta(entrada.provedor, env)
  if (falta) return new LlmFerramentasNaoImplementado(`${entrada.provedor}: falta ${falta}`)
  const timeoutMs = timeoutDoAmbiente(env)
  if (entrada.provedor === 'claude') return new LlmClaudeFerramentas({ apiKey: env.ANTHROPIC_API_KEY!.trim(), modelo: entrada.modelo })
  const c = COMPAT[entrada.provedor]
  return new LlmOpenRouterFerramentas({ preset: entrada.provedor, apiKey: env[c.chave]!.trim(), modelos: [entrada.modelo], timeoutMs })
}

function timeoutDoAmbiente(env: NodeJS.ProcessEnv): number | undefined {
  const bruto = Number(env.IA_TIMEOUT_MS)
  return Number.isFinite(bruto) && bruto >= 1_000 && bruto <= 120_000 ? bruto : undefined
}

const PROVEDORES: readonly ProvedorLlm[] = ['claude', ...(Object.keys(COMPAT) as (keyof typeof COMPAT)[])]
function ehProvedor(v: string | undefined): v is ProvedorLlm {
  return !!v && (PROVEDORES as readonly string[]).includes(v)
}

/** O modelo da reserva: `IA_RESERVA_MODELO` ou o padrão do fornecedor (o openrouter não tem). */
function modeloDaReserva(provedor: ProvedorLlm, env: NodeJS.ProcessEnv): string | null {
  const pedido = env.IA_RESERVA_MODELO?.trim()
  if (pedido) return pedido
  return provedor === 'claude' ? MODELO_PADRAO_CLAUDE : COMPAT[provedor].modeloPadrao
}

/**
 * O que falta para a reserva funcionar — vazio quando está pronta OU quando
 * não foi pedida (`IA_RESERVA_PROVEDOR` ausente). Para a tela e o smoke.
 */
export function faltaParaReserva(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const pedido = env.IA_RESERVA_PROVEDOR?.trim()
  if (!pedido) return []
  if (!ehProvedor(pedido)) return [`IA_RESERVA_PROVEDOR inválido (${pedido}): use ${PROVEDORES.join(' | ')}`]
  const falta: string[] = []
  const chave = chaveQueFalta(pedido, env)
  if (chave) falta.push(chave)
  if (!modeloDaReserva(pedido, env)) falta.push('IA_RESERVA_MODELO')
  return falta
}

/** A reserva configurada e pronta; null sem `IA_RESERVA_PROVEDOR` ou com algo faltando. */
export function reservaDoAmbiente(env: NodeJS.ProcessEnv = process.env): LadoLlm | null {
  const provedor = env.IA_RESERVA_PROVEDOR?.trim()
  if (!ehProvedor(provedor) || faltaParaReserva(env).length > 0) return null
  const modelo = modeloDaReserva(provedor, env)!
  return { porta: adaptadorDoCatalogo({ provedor, modelo }, env), modelo }
}

export function janelaDaReservaMs(env: NodeJS.ProcessEnv = process.env): number {
  const min = Number(env.IA_RESERVA_JANELA_MIN)
  return Number.isFinite(min) && min >= 1 && min <= 1_440 ? Math.round(min * 60_000) : JANELA_RESERVA_PADRAO_MS
}

/** O modelo que o adaptador do ambiente usa (para bloqueio e log). */
function modeloDoAmbiente(env: NodeJS.ProcessEnv): string {
  const pedido = env.IA_PROVEDOR?.trim()
  const primeiro = env.IA_MODELO?.split(',')[0]?.trim()
  if (pedido === 'groq' || pedido === 'gemini' || pedido === 'cerebras' || pedido === 'maritaca') return primeiro || COMPAT[pedido].modeloPadrao
  if (pedido === 'openrouter' || (!pedido && !env.ANTHROPIC_API_KEY?.trim())) return env.IA_MODELO?.trim() ?? ''
  return primeiro || MODELO_PADRAO_CLAUDE
}

/** O `IA_MODELO` do ambiente como lado do roteador — null quando não há um real pronto. */
function padraoDoAmbiente(env: NodeJS.ProcessEnv): LadoLlm | null {
  if (env.IA_PROVEDOR?.trim() === 'simulado' || faltaParaLlmFerramentas(env).length > 0) return null
  return { porta: adaptadorDoAmbiente(env), modelo: modeloDoAmbiente(env) }
}

export function faltaParaLlmFerramentas(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const pedido = env.IA_PROVEDOR?.trim()
  if (pedido === 'simulado') return env.NODE_ENV === 'production' ? ['IA_PROVEDOR=simulado não é permitido em produção'] : []
  if (pedido === 'groq' || pedido === 'gemini' || pedido === 'cerebras' || pedido === 'maritaca') {
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
  // ⚠️ O simulado não passa pelo roteador: é regra local, não fornecedor.
  if (env.IA_PROVEDOR?.trim() === 'simulado' && faltaParaLlmFerramentas(env).length === 0) return new LlmSimulado()
  return new RoteadorLlm({
    principal: { porta: adaptadorDoAmbiente(env), modelo: modeloDoAmbiente(env) },
    reserva: reservaDoAmbiente(env) ?? undefined,
    janelaMs: janelaDaReservaMs(env),
  })
}

/** O adaptador CRU do ambiente (sem roteador). */
function adaptadorDoAmbiente(env: NodeJS.ProcessEnv): PortaLlmFerramentas {
  const falta = faltaParaLlmFerramentas(env)
  if (falta.length) return new LlmFerramentasNaoImplementado(falta.join('; '))
  const pedido = env.IA_PROVEDOR?.trim()
  const timeoutMs = timeoutDoAmbiente(env)
  if (pedido === 'simulado') return new LlmSimulado()
  if (pedido === 'groq' || pedido === 'gemini' || pedido === 'cerebras' || pedido === 'maritaca') {
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
