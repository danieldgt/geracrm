import { ESQUEMA_RESPOSTA, instrucaoDeSistema, propostaDoRetorno } from './instrucao.js'
import type {
  CapacidadesLlm, CustoDoTurno, MotivoFalhaLlm, PedidoDeTurno,
  PortaLlm, PropostaDeTurno, ResultadoLlm,
} from './porta.js'

/**
 * Adaptador de LLM — OpenRouter. O SEGUNDO adaptador da mesma porta.
 *
 * ⚠️ O formato do fio é outro (compatível com OpenAI: `choices[].message
 * .tool_calls[]`, argumentos em JSON como STRING) e só este arquivo sabe disso.
 * A instrução e o esquema vêm de `instrucao.ts`, compartilhados com o adaptador
 * direto da Anthropic — dois prompts diferentes fariam o agente se comportar de
 * um jeito num cliente e de outro noutro, sem ninguém conseguir reproduzir.
 *
 * ⚠️ **O OpenRouter é um INTERMEDIÁRIO.** A conversa passa por ele E pelo
 * provedor de baixo — dois terceiros no caminho de dado pessoal, contra um.
 * Isso é decisão de contrato e de política de privacidade, não de código; está
 * registrado aqui porque o código é onde alguém vai procurar depois.
 */

const URL_COMPLETIONS = 'https://openrouter.ai/api/v1/chat/completions'
const MAX_TOKENS_SAIDA = 700

export interface CredencialOpenRouter {
  readonly apiKey: string
  /**
   * ⚠️ OBRIGATÓRIO aqui, diferente do adaptador direto. O catálogo do OpenRouter
   * muda e cada modelo tem um identificador próprio ("fornecedor/modelo"), então
   * chutar um padrão produziria um 400 sobre modelo inexistente — erro que não
   * se parece em nada com "faltou configurar".
   */
  readonly modelo: string
}

export class LlmOpenRouter implements PortaLlm {
  readonly nome = 'openrouter'
  readonly capacidades: CapacidadesLlm = { saidaEstruturada: true, instrucaoDeSistema: true }

  readonly #apiKey: string
  readonly #modelo: string
  readonly #buscar: typeof fetch
  readonly #timeoutMs: number

  constructor(cred: CredencialOpenRouter, opcoes: { buscar?: typeof fetch; timeoutMs?: number } = {}) {
    this.#apiKey = cred.apiKey
    this.#modelo = cred.modelo.trim()
    this.#buscar = opcoes.buscar ?? fetch
    this.#timeoutMs = opcoes.timeoutMs ?? 20_000
  }

  async conversar(pedido: PedidoDeTurno): Promise<ResultadoLlm<PropostaDeTurno>> {
    const corpo = {
      model: this.#modelo,
      max_tokens: MAX_TOKENS_SAIDA,
      // No formato OpenAI a instrução é a primeira MENSAGEM, não um campo à parte.
      messages: [
        { role: 'system', content: instrucaoDeSistema(pedido) },
        ...pedido.historico.map((f) => ({
          role: f.de === 'cliente' ? 'user' : 'assistant',
          content: f.texto,
        })),
      ],
      tools: [{
        type: 'function',
        function: {
          name: ESQUEMA_RESPOSTA.nome,
          description: ESQUEMA_RESPOSTA.descricao,
          parameters: ESQUEMA_RESPOSTA.parametros,
        },
      }],
      tool_choice: { type: 'function', function: { name: ESQUEMA_RESPOSTA.nome } },
    }

    let resposta: Response
    try {
      resposta = await this.#buscar(URL_COMPLETIONS, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.#apiKey}`,
          // Identificação da aplicação no painel do OpenRouter — não é segredo.
          'x-title': 'Drezz Hub',
        },
        body: JSON.stringify(corpo),
        signal: AbortSignal.timeout(this.#timeoutMs),
      })
    } catch (e) {
      return { ok: false, motivo: 'indisponivel', detalhe: String(e) }
    }

    const dados = await resposta.json().catch(() => null) as Record<string, unknown> | null
    if (!resposta.ok) return { ok: false, ...traduzirErro(resposta.status, dados) }

    // ⚠️ O OpenRouter devolve HTTP 200 com um `error` dentro quando o roteamento
    //    falha (nenhum provedor disponível para o modelo). Ler só o status daria
    //    "resposta_inesperada" para algo que é indisponibilidade, e o log
    //    mandaria alguém procurar bug no nosso parser.
    if (dados?.['error']) {
      const e = dados['error'] as Record<string, unknown>
      return { ok: false, ...traduzirErro(Number(e['code'] ?? 502), dados) }
    }

    const escolha = (Array.isArray(dados?.['choices']) ? dados['choices'][0] : null) as Record<string, unknown> | null
    const mensagem = (escolha?.['message'] ?? {}) as Record<string, unknown>

    if (escolha?.['finish_reason'] === 'content_filter') {
      return { ok: false, motivo: 'conteudo_recusado', detalhe: 'filtro de conteúdo do provedor' }
    }

    const chamada = (Array.isArray(mensagem['tool_calls']) ? mensagem['tool_calls'][0] : null) as
      Record<string, unknown> | null
    const fn = (chamada?.['function'] ?? {}) as Record<string, unknown>

    // ⚠️ Aqui os argumentos vêm como STRING de JSON, não como objeto — é a
    //    diferença de formato que justifica este adaptador existir. JSON
    //    truncado (estouro de tokens) cai no catch e vira falha nomeada, nunca
    //    exceção subindo para a ingestão da mensagem.
    let entrada: Record<string, unknown> | undefined
    try {
      const bruto = fn['arguments']
      entrada = typeof bruto === 'string' ? JSON.parse(bruto) : (bruto as Record<string, unknown>)
    } catch {
      return { ok: false, motivo: 'resposta_inesperada', detalhe: 'argumentos da ferramenta não são JSON válido' }
    }

    const proposta = propostaDoRetorno(entrada)
    if (!proposta) {
      return { ok: false, motivo: 'resposta_inesperada', detalhe: 'resposta sem chamada de ferramenta' }
    }
    return { ok: true, dados: proposta, custo: extrairCusto(dados, this.#modelo) }
  }
}

function extrairCusto(dados: Record<string, unknown> | null, modelo: string): CustoDoTurno {
  const uso = (dados?.['usage'] ?? {}) as Record<string, unknown>
  return {
    tokensEntrada: Number(uso['prompt_tokens'] ?? 0),
    tokensSaida: Number(uso['completion_tokens'] ?? 0),
    modelo,
  }
}

function traduzirErro(
  status: number, corpo: Record<string, unknown> | null,
): { motivo: MotivoFalhaLlm; detalhe?: string } {
  const erro = (corpo?.['error'] ?? {}) as Record<string, unknown>
  const detalhe = typeof erro['message'] === 'string' ? erro['message'] : `HTTP ${status}`
  if (status === 401 || status === 403) return { motivo: 'credencial_invalida', detalhe }
  // ⚠️ 402 é CRÉDITO ACABADO no OpenRouter — não existe no adaptador direto.
  //    Não é erro de chave nem de taxa: insistir não resolve e esperar também
  //    não. Alguém precisa recarregar, e o motivo tem de dizer isso.
  if (status === 402) return { motivo: 'limite_de_custo', detalhe: `sem créditos no OpenRouter: ${detalhe}` }
  if (status === 429) return { motivo: 'limite_de_taxa', detalhe }
  if (status >= 500) return { motivo: 'indisponivel', detalhe }
  return { motivo: 'resposta_inesperada', detalhe }
}
