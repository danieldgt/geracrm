import { LlmClaude } from './claude.js'
import { LlmOpenRouter } from './openrouter.js'
import { LlmNaoImplementado, type PortaLlm } from './porta.js'

/**
 * Monta o adaptador de LLM a partir das VARIÁVEIS DE AMBIENTE.
 *
 * ⚠️ **A chave do modelo é NOSSA, não do tenant** — e essa é a diferença que
 * decide onde ela mora. Mesmo raciocínio da fábrica de plataforma de mídia:
 *
 * | | Credencial de canal (WhatsApp) | Chave do LLM |
 * |---|---|---|
 * | De quem é | **do tenant** — cada cliente traz a sua | **nossa** — uma serve todos |
 * | Onde mora | cifrada em `canal_conectado` | ⚠️ **variável de ambiente** |
 * | Quantas | uma por número | **uma só** |
 *
 * Guardar isto por tenant criaria N cópias do mesmo segredo, com N chances de
 * vazar e nenhuma vantagem. O que muda por cliente são as políticas curadas e o
 * contexto do lead — dados, não credencial.
 *
 * ⚠️ Em produção (Railway) as variáveis vêm do painel do serviço; em dev, do
 * `.env`. Nunca de arquivo dentro do repositório, e nunca coladas numa conversa.
 */

export const PROVEDORES_LLM = ['claude', 'openrouter'] as const
export type ProvedorLlm = (typeof PROVEDORES_LLM)[number]

export interface ConfigLlm {
  readonly provedor: ProvedorLlm
  readonly apiKey: string
  readonly modelo?: string | undefined
}

/**
 * Qual fornecedor usar.
 *
 * ⚠️ `IA_PROVEDOR` manda quando existe. Sem ele, vale a chave que estiver
 * configurada — e o direto vem primeiro de propósito: um intermediário a menos
 * no caminho de dado pessoal. Se as duas existirem, a escolha é explícita ou é
 * a mais curta.
 */
function escolherProvedor(env: NodeJS.ProcessEnv): ProvedorLlm | null {
  const pedido = env.IA_PROVEDOR?.trim() as ProvedorLlm | undefined
  if (pedido && (PROVEDORES_LLM as readonly string[]).includes(pedido)) return pedido
  if (env.ANTHROPIC_API_KEY?.trim()) return 'claude'
  if (env.OPENROUTER_API_KEY?.trim()) return 'openrouter'
  return null
}

/**
 * O que falta para a IA funcionar, na linguagem de quem vai configurar.
 *
 * ⚠️ Existe para a tela poder dizer "falta OPENROUTER_API_KEY" em vez de "IA
 * indisponível". Erro genérico manda a pessoa abrir chamado; nome de variável
 * manda ela resolver.
 */
export function faltaParaLlm(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const provedor = escolherProvedor(env)
  if (!provedor) return ['ANTHROPIC_API_KEY (ou OPENROUTER_API_KEY + IA_MODELO)']

  const falta: string[] = []
  if (provedor === 'claude') {
    if (!env.ANTHROPIC_API_KEY?.trim()) falta.push('ANTHROPIC_API_KEY')
  } else {
    if (!env.OPENROUTER_API_KEY?.trim()) falta.push('OPENROUTER_API_KEY')
    // ⚠️ No OpenRouter o modelo é obrigatório: o catálogo muda e cada modelo tem
    //    identificador próprio ("fornecedor/modelo"). Chutar um padrão daria um
    //    400 sobre modelo inexistente — erro que não se parece com "faltou
    //    configurar", e que manda a pessoa procurar no lugar errado.
    if (!env.IA_MODELO?.trim()) falta.push('IA_MODELO')
  }
  return falta
}

export function configLlmDoAmbiente(env: NodeJS.ProcessEnv = process.env): ConfigLlm | null {
  if (faltaParaLlm(env).length > 0) return null
  const provedor = escolherProvedor(env)!
  return {
    provedor,
    apiKey: (provedor === 'claude' ? env.ANTHROPIC_API_KEY! : env.OPENROUTER_API_KEY!).trim(),
    modelo: env.IA_MODELO?.trim() || undefined,
  }
}

/**
 * Devolve o adaptador do provedor.
 *
 * ⚠️ Provedor desconhecido vira `LlmNaoImplementado`, que responde com falha
 * NOMEADA em vez de lançar. O agente trata isso como fornecedor fora do ar e
 * manda a conversa para a fila humana — lançar aqui derrubaria a ingestão de uma
 * mensagem que já está salva no banco.
 */
export function criarLlm(
  cfg: ConfigLlm | null,
  opcoes: { buscar?: typeof fetch; timeoutMs?: number } = {},
): PortaLlm {
  if (!cfg) return new LlmNaoImplementado('sem chave configurada')
  switch (cfg.provedor) {
    case 'claude':
      return new LlmClaude({ apiKey: cfg.apiKey, ...(cfg.modelo ? { modelo: cfg.modelo } : {}) }, opcoes)
    case 'openrouter':
      if (!cfg.modelo) return new LlmNaoImplementado('openrouter sem IA_MODELO')
      return new LlmOpenRouter({ apiKey: cfg.apiKey, modelo: cfg.modelo }, opcoes)
    default:
      return new LlmNaoImplementado(String(cfg.provedor))
  }
}

/** Atalho para o caminho comum: ambiente → adaptador. */
export function llmDoAmbiente(
  env: NodeJS.ProcessEnv = process.env,
  opcoes: { buscar?: typeof fetch; timeoutMs?: number } = {},
): PortaLlm {
  return criarLlm(configLlmDoAmbiente(env), opcoes)
}
