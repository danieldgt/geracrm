import { LlmClaude } from './claude.js'
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

/** Provedores com adaptador escrito. */
export const PROVEDORES_LLM = ['claude'] as const
export type ProvedorLlm = (typeof PROVEDORES_LLM)[number]

export interface ConfigLlm {
  readonly provedor: ProvedorLlm
  readonly apiKey: string
  readonly modelo?: string | undefined
}

/**
 * O que falta para a IA funcionar, na linguagem de quem vai configurar.
 *
 * ⚠️ Existe para a tela poder dizer "falta ANTHROPIC_API_KEY" em vez de "IA
 * indisponível". Erro genérico manda a pessoa abrir chamado; nome de variável
 * manda ela resolver.
 */
export function faltaParaLlm(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  return env.ANTHROPIC_API_KEY?.trim() ? [] : ['ANTHROPIC_API_KEY']
}

export function configLlmDoAmbiente(env: NodeJS.ProcessEnv = process.env): ConfigLlm | null {
  if (faltaParaLlm(env).length > 0) return null
  return {
    provedor: 'claude',
    apiKey: env.ANTHROPIC_API_KEY!.trim(),
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
