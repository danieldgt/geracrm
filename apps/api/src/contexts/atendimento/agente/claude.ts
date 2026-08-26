import type {
  CapacidadesLlm, CustoDoTurno, MotivoFalhaLlm, PedidoDeTurno,
  PortaLlm, PropostaDeTurno, ResultadoLlm,
} from './porta.js'

/**
 * Adaptador de LLM — Anthropic (Claude). Um dos adaptadores da porta `PortaLlm`.
 *
 * ⚠️ Só ESTE arquivo conhece o formato da Anthropic. O agente fala com a porta e
 * não sabe se a resposta veio em `content[]`, `choices[]` ou outra coisa — é a
 * mesma regra dos conectores de ERP e das plataformas de mídia (ADR-008).
 *
 * ⚠️ `buscar` é injetável e o fornecedor é SEMPRE mockado em teste: chamar a API
 * real no CI custa dinheiro, é lento e falha quando a rede oscila (skill
 * `geracrm-ia`).
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

  constructor(
    cred: CredencialClaude,
    opcoes: { buscar?: typeof fetch; timeoutMs?: number } = {},
  ) {
    this.#apiKey = cred.apiKey
    this.#modelo = cred.modelo?.trim() || MODELO_PADRAO
    this.#buscar = opcoes.buscar ?? fetch
    // ⚠️ Um cliente esperando no WhatsApp não aguenta 60s. Estourou, vai para a
    //    fila humana — que é melhor que uma resposta que chega depois de a
    //    pessoa ter desistido.
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
      tools: [FERRAMENTA_RESPOSTA],
      tool_choice: { type: 'tool', name: FERRAMENTA_RESPOSTA.name },
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

    const proposta = extrairProposta(dados)
    if (!proposta) {
      return { ok: false, motivo: 'resposta_inesperada', detalhe: 'sem bloco de ferramenta na resposta' }
    }
    return { ok: true, dados: proposta, custo: extrairCusto(dados, this.#modelo) }
  }
}

/**
 * ⚠️ O ESQUEMA é o contrato. Campo que não está aqui não volta — e o que volta
 * ainda é validado pelo domínio antes de encostar no cadastro.
 */
const FERRAMENTA_RESPOSTA = {
  name: 'responder_ao_lead',
  description: 'Responde ao lead e propõe o próximo passo.',
  input_schema: {
    type: 'object',
    properties: {
      texto: { type: 'string', description: 'A mensagem a enviar, em pt-BR, curta.' },
      proximoPasso: { type: 'string', enum: ['continuar', 'entregar', 'desistir'] },
      motivo: { type: 'string', description: 'Por que entregar ou desistir. Vazio se continuar.' },
      extraido: {
        type: 'object',
        description: 'Só o que o LEAD disse nesta conversa. Nunca deduza nem invente.',
        properties: {
          tipoCompra: { type: 'string', enum: ['consumo_final', 'revenda'] },
          cidade: { type: 'string' },
          volume: { type: 'string' },
          cnpj: { type: 'string' },
        },
      },
    },
    required: ['texto', 'proximoPasso'],
  },
} as const

/**
 * A instrução de sistema.
 *
 * ⚠️ **Nenhuma regra de negócio aqui.** Preço, pedido mínimo e prazo são domínio
 * — o que entra é o que o cliente CUROU (políticas) e o que já sabemos do lead.
 * Regra escrita no prompt falha em silêncio e ninguém testa.
 */
function instrucaoDeSistema(p: PedidoDeTurno): string {
  const l = p.lead
  const sabemos = [
    l.nome ? `Nome: ${l.nome}.` : null,
    l.jaEhCliente ? `JÁ É CLIENTE (${l.comprasNoUltimoAno} compras no último ano).` : 'Ainda não é cliente.',
    l.ultimaCompraEm ? `Última compra em ${l.ultimaCompraEm}.` : null,
    l.cidade ? `Cidade: ${l.cidade}.` : null,
    l.temCnpj ? 'CNPJ já cadastrado.' : null,
  ].filter(Boolean).join(' ')

  return [
    'Você atende no WhatsApp de uma loja, FORA DO HORÁRIO comercial.',
    'Seu papel é entender o que a pessoa precisa e preparar a entrega para um humano pela manhã.',
    '',
    'REGRAS:',
    `- Escreva em pt-BR, no máximo ${p.maxCaracteres} caracteres, tom de gente.`,
    '- NUNCA fale preço, prazo de entrega ou desconto que não esteja nas POLÍTICAS abaixo.',
    '- NUNCA prometa, feche pedido ou confirme disponibilidade.',
    '- NÃO pergunte o que já sabemos (abaixo). Pergunte só o que falta.',
    '- Se a pessoa pedir humano, reclamar, cobrar ou falar de problema com pedido: proximoPasso = entregar.',
    '- Se não souber responder pelas políticas: proximoPasso = entregar, com o motivo.',
    '- Em extraido, só o que a pessoa DISSE nesta conversa. Nunca deduza.',
    '',
    `O QUE JÁ SABEMOS: ${sabemos || 'nada além do contato.'}`,
    '',
    'POLÍTICAS DA LOJA:',
    p.politicas.trim(),
  ].join('\n')
}

function extrairProposta(dados: Record<string, unknown> | null): PropostaDeTurno | null {
  const blocos = Array.isArray(dados?.['content']) ? dados['content'] as Record<string, unknown>[] : []
  const uso = blocos.find((b) => b['type'] === 'tool_use')
  const entrada = uso?.['input'] as Record<string, unknown> | undefined
  const texto = typeof entrada?.['texto'] === 'string' ? entrada['texto'].trim() : ''
  if (!texto) return null

  const passo = entrada?.['proximoPasso']
  const proximoPasso = passo === 'entregar' || passo === 'desistir' ? passo : 'continuar'
  const extraido = (entrada?.['extraido'] ?? {}) as Record<string, string | number | boolean | null>

  return {
    texto,
    proximoPasso,
    motivo: typeof entrada?.['motivo'] === 'string' ? entrada['motivo'] : '',
    extraidoBruto: extraido,
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
