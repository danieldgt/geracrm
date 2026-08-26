import { ESQUEMA_RESPOSTA, instrucaoDeSistema, propostaDoRetorno } from './instrucao.js'
import type {
  CapacidadesLlm, CustoDoTurno, MotivoFalhaLlm, PedidoDeTurno,
  PortaLlm, PropostaDeTurno, ResultadoLlm,
} from './porta.js'

/**
 * Adaptador de LLM — Anthropic (Claude) DIRETO. Um dos adaptadores da porta.
 *
 * ⚠️ Só ESTE arquivo conhece o formato da Anthropic. O agente fala com a porta e
 * não sabe se a resposta veio em `content[]` ou em `choices[]` — mesma regra dos
 * conectores de ERP e das plataformas de mídia (ADR-008).
 *
 * ⚠️ `buscar` é injetável e o fornecedor é SEMPRE mockado em teste: chamar a API
 * real no CI custa dinheiro, é lento e falha quando a rede oscila.
 */

const URL_MENSAGENS = 'https://api.anthropic.com/v1/messages'
const VERSAO_API = '2023-06-01'

/**
 * ⚠️ Escolha do modelo pela TAREFA, não pelo tamanho. Conversar com um lead e
 * extrair meia dúzia de campos não exige o modelo maior, e usar o maior para
 * tudo é desperdício que aparece na fatura no fim do mês.
 */
const MODELO_PADRAO = 'claude-sonnet-5'

/** ⚠️ Teto de saída: resposta de WhatsApp, não redação. */
const MAX_TOKENS_SAIDA = 700

export interface CredencialClaude {
  readonly apiKey: string
  readonly modelo?: string
}

export class LlmClaude implements PortaLlm {
  readonly nome = 'claude'
  readonly capacidades: CapacidadesLlm = { saidaEstruturada: true, instrucaoDeSistema: true }

  readonly #apiKey: string
  readonly #modelo: string
  readonly #buscar: typeof fetch
  readonly #timeoutMs: number

  constructor(cred: CredencialClaude, opcoes: { buscar?: typeof fetch; timeoutMs?: number } = {}) {
    this.#apiKey = cred.apiKey
    this.#modelo = cred.modelo?.trim() || MODELO_PADRAO
    this.#buscar = opcoes.buscar ?? fetch
    // ⚠️ Um cliente esperando no WhatsApp não aguenta 60s. Estourou, vai para a
    //    fila humana — melhor que uma resposta que chega depois da desistência.
    this.#timeoutMs = opcoes.timeoutMs ?? 20_000
  }

  async conversar(pedido: PedidoDeTurno): Promise<ResultadoLlm<PropostaDeTurno>> {
    const corpo = {
      model: this.#modelo,
      max_tokens: MAX_TOKENS_SAIDA,
      system: instrucaoDeSistema(pedido),
      messages: pedido.historico.map((f) => ({
        role: f.de === 'cliente' ? 'user' : 'assistant',
        content: f.texto,
      })),
      // ⚠️ Saída estruturada por ferramenta: pedir "responda em JSON" no texto
      //    funciona até o dia em que o modelo resolve explicar o JSON antes de
      //    escrevê-lo. A ferramenta torna o formato parte do contrato.
      tools: [{
        name: ESQUEMA_RESPOSTA.nome,
        description: ESQUEMA_RESPOSTA.descricao,
        input_schema: ESQUEMA_RESPOSTA.parametros,
      }],
      tool_choice: { type: 'tool', name: ESQUEMA_RESPOSTA.nome },
    }

    let resposta: Response
    try {
      resposta = await this.#buscar(URL_MENSAGENS, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.#apiKey,
          'anthropic-version': VERSAO_API,
        },
        body: JSON.stringify(corpo),
        signal: AbortSignal.timeout(this.#timeoutMs),
      })
    } catch (e) {
      // Timeout e queda de rede são a mesma decisão para quem opera: fila humana.
      return { ok: false, motivo: 'indisponivel', detalhe: String(e) }
    }

    const dados = await resposta.json().catch(() => null) as Record<string, unknown> | null
    if (!resposta.ok) return { ok: false, ...traduzirErro(resposta.status, dados) }

    // ⚠️ `stop_reason: 'refusal'` é recusa de conteúdo, não erro de rede: repetir
    //    não resolve, e o cliente continua esperando alguém.
    if (dados?.['stop_reason'] === 'refusal') {
      return { ok: false, motivo: 'conteudo_recusado', detalhe: 'o modelo recusou responder' }
    }

    const blocos = Array.isArray(dados?.['content']) ? dados['content'] as Record<string, unknown>[] : []
    const uso = blocos.find((b) => b['type'] === 'tool_use')
    const proposta = propostaDoRetorno(uso?.['input'] as Record<string, unknown> | undefined)
    if (!proposta) {
      return { ok: false, motivo: 'resposta_inesperada', detalhe: 'sem bloco de ferramenta na resposta' }
    }
    return { ok: true, dados: proposta, custo: extrairCusto(dados, this.#modelo) }
  }
}

function extrairCusto(dados: Record<string, unknown> | null, modelo: string): CustoDoTurno {
  const uso = (dados?.['usage'] ?? {}) as Record<string, unknown>
  return {
    tokensEntrada: Number(uso['input_tokens'] ?? 0),
    tokensSaida: Number(uso['output_tokens'] ?? 0),
    modelo,
  }
}

function traduzirErro(
  status: number, corpo: Record<string, unknown> | null,
): { motivo: MotivoFalhaLlm; detalhe?: string } {
  const erro = (corpo?.['error'] ?? {}) as Record<string, unknown>
  const detalhe = typeof erro['message'] === 'string' ? erro['message'] : `HTTP ${status}`
  if (status === 401 || status === 403) return { motivo: 'credencial_invalida', detalhe }
  // ⚠️ 529 é "overloaded" da Anthropic — recuar, como no 429.
  if (status === 429 || status === 529) return { motivo: 'limite_de_taxa', detalhe }
  if (status >= 500) return { motivo: 'indisponivel', detalhe }
  return { motivo: 'resposta_inesperada', detalhe }
}
