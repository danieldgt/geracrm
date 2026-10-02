import Anthropic from '@anthropic-ai/sdk'
import type {
  PedidoDeLaco, PortaLlmFerramentas, ResultadoLaco, CapacidadesLlmFerramentas, ChamadaRegistrada, RastroDoLaco,
} from './porta-llm.js'
import type { MotivoFalhaLlm } from './porta.js'

/**
 * Adaptador ANTHROPIC com laço de ferramentas — SDK oficial, modelo da família
 * Claude 5 (skill `claude-api`).
 *
 * ⚠️ `tool_choice` é SEMPRE `auto`: forçar ferramenta (`any`/`tool`) devolve
 * 400 em Opus 5.5 / Sonnet 5.5 — foi o que quebrou o adaptador anterior. O
 * esquema da saída final vai em `output_config.format`, e as ferramentas levam
 * `strict: true` para a entrada chegar válida.
 *
 * ⚠️ Cache de prefixo em três pontos (tools → system global → system do
 * tenant). Nada volátil entra no system; o turno vai como operador dentro das
 * mensagens.
 */

export const MODELO_PADRAO = 'claude-opus-5-5'

export interface ConfigClaudeFerramentas {
  readonly apiKey: string
  readonly modelo?: string | undefined
  readonly baseUrl?: string | undefined
  /** Costura de teste: cliente já construído (ou falso). */
  readonly cliente?: Anthropic | undefined
}

export class LlmClaudeFerramentas implements PortaLlmFerramentas {
  readonly nome = 'claude'
  readonly capacidades: CapacidadesLlmFerramentas = { ferramentas: true, saidaEstruturada: true, cacheDePrefixo: true }
  private readonly cliente: Anthropic
  private readonly modelo: string

  constructor(cfg: ConfigClaudeFerramentas) {
    this.modelo = cfg.modelo?.trim() || MODELO_PADRAO
    this.cliente = cfg.cliente ?? new Anthropic({ apiKey: cfg.apiKey, maxRetries: 1, ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}) })
  }

  async rodar(pedido: PedidoDeLaco): Promise<ResultadoLaco> {
    const inicio = Date.now()
    const modelo = pedido.modelo?.trim() || this.modelo
    const prazo = new AbortController()
    const timer = setTimeout(() => prazo.abort(), pedido.limites.prazoMs)
    const chamadas: ChamadaRegistrada[] = []
    const uso = { entrada: 0, saida: 0, cacheLeitura: 0, cacheEscrita: 0 }
    const rastro = (parouPor: RastroDoLaco['parouPor']): RastroDoLaco => ({
      chamadas, rodadas, uso, modelo, latenciaMs: Date.now() - inicio, parouPor,
    })

    const tools = pedido.ferramentas.map((f, i) => ({
      name: f.nome, description: f.descricao, strict: true as const,
      input_schema: f.esquema as Anthropic.Tool['input_schema'],
      // Breakpoint 1: a lista de ferramentas é estável — cacheia como um bloco.
      ...(i === pedido.ferramentas.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
    }))
    const system: Anthropic.TextBlockParam[] = pedido.sistema.map((b) => ({
      type: 'text', text: b.texto, ...(b.cachear ? { cache_control: { type: 'ephemeral' as const } } : {}),
    }))
    const messages = paraMensagens(pedido.mensagens)
    let rodadas = 0
    let comFormato = true

    try {
      while (true) {
        rodadas += 1
        let resposta: Anthropic.Message
        try {
          resposta = await this.cliente.messages.create({
            model: modelo,
            max_tokens: pedido.limites.maxTokensSaida,
            system,
            ...(tools.length ? { tools, tool_choice: { type: 'auto' } } : {}),
            messages,
            output_config: {
              effort: pedido.esforco ?? 'low',
              ...(comFormato ? { format: { type: 'json_schema', schema: pedido.esquemaSaida } } : {}),
            },
          }, { signal: prazo.signal })
        } catch (e) {
          // ⚠️ Se o fornecedor recusar `format` junto de ferramentas, tenta UMA vez
          //    sem: a saída volta como texto JSON e o domínio ainda a valida.
          if (comFormato && e instanceof Anthropic.BadRequestError && /output_config|format/i.test(e.message)) {
            comFormato = false; rodadas -= 1; continue
          }
          throw e
        }
        somarUso(uso, resposta.usage)

        if (resposta.stop_reason === 'refusal') {
          return { ok: false, motivo: 'conteudo_recusado', detalhe: resposta.stop_details?.explanation ?? undefined, rastro: rastro('fim') }
        }
        if (resposta.stop_reason === 'max_tokens') {
          return { ok: false, motivo: 'resposta_inesperada', detalhe: `estourou o teto de ${pedido.limites.maxTokensSaida} tokens de saída`, rastro: rastro('max_tokens') }
        }

        const usos = resposta.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
        if (resposta.stop_reason === 'tool_use' && usos.length > 0) {
          messages.push({ role: 'assistant', content: resposta.content })
          const resultados: Anthropic.ToolResultBlockParam[] = await Promise.all(usos.map(async (u) => {
            const t0 = Date.now()
            const r = await pedido.executar(u.name, u.input)
            chamadas.push({ nome: u.name, entrada: u.input, saida: r.ok ? r.saida : null, ms: Date.now() - t0, ...(r.ok ? {} : { erro: r.erro }) })
            return {
              type: 'tool_result', tool_use_id: u.id,
              content: `<dados_externos>${JSON.stringify(r.ok ? r.saida : { erro: r.erro })}</dados_externos>`,
              ...(r.ok ? {} : { is_error: true }),
            }
          }))
          messages.push({ role: 'user', content: resultados })
          if (rodadas >= pedido.limites.maxRodadas) {
            // Última chance: pede a resposta final sem mais ferramentas.
            const final = await this.cliente.messages.create({
              model: modelo, max_tokens: pedido.limites.maxTokensSaida, system, messages,
              ...(tools.length ? { tools, tool_choice: { type: 'none' } } : {}),
              output_config: { effort: pedido.esforco ?? 'low', ...(comFormato ? { format: { type: 'json_schema', schema: pedido.esquemaSaida } } : {}) },
            }, { signal: prazo.signal })
            somarUso(uso, final.usage)
            const saida = textoDe(final)
            return saidaFinal(saida, rastro('max_rodadas'))
          }
          continue
        }

        return saidaFinal(textoDe(resposta), rastro('fim'))
      }
    } catch (e) {
      return { ok: false, ...mapearErro(e), rastro: rastro(prazo.signal.aborted ? 'prazo' : 'fim') }
    } finally {
      clearTimeout(timer)
    }
  }
}

function saidaFinal(texto: string, rastro: RastroDoLaco): ResultadoLaco {
  const limpo = texto.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')
  try {
    return { ok: true, saida: JSON.parse(limpo), rastro }
  } catch {
    return { ok: false, motivo: 'resposta_inesperada', detalhe: `não veio JSON: ${limpo.slice(0, 120)}`, rastro }
  }
}

function textoDe(m: Anthropic.Message): string {
  return m.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n')
}

function somarUso(uso: { entrada: number; saida: number; cacheLeitura: number; cacheEscrita: number }, u: Anthropic.Usage): void {
  uso.entrada += u.input_tokens ?? 0
  uso.saida += u.output_tokens ?? 0
  uso.cacheLeitura += u.cache_read_input_tokens ?? 0
  uso.cacheEscrita += u.cache_creation_input_tokens ?? 0
}

/**
 * Nossa conversa → `messages` da API. Falas consecutivas do mesmo lado viram
 * uma; a primeira precisa ser `user`; o operador vai como `system` DEPOIS da
 * última fala do cliente (regra do fornecedor: segue um user e é o último).
 */
export function paraMensagens(falas: readonly PedidoDeLaco['mensagens'][number][]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = []
  const operador: string[] = []
  for (const f of falas) {
    if (f.papel === 'operador') { operador.push(f.texto); continue }
    const role = f.papel === 'cliente' ? 'user' : 'assistant'
    const ultimo = out[out.length - 1]
    if (ultimo && ultimo.role === role && typeof ultimo.content === 'string') {
      ultimo.content = `${ultimo.content}\n${f.texto}`
    } else out.push({ role, content: f.texto })
  }
  if (out.length === 0 || out[0]!.role !== 'user') out.unshift({ role: 'user', content: '[início da conversa]' })
  if (out[out.length - 1]!.role !== 'user') out.push({ role: 'user', content: '[o cliente ainda não respondeu; continue de onde parou]' })
  if (operador.length) out.push({ role: 'system', content: operador.join('\n') })
  return out
}

function mapearErro(e: unknown): { motivo: MotivoFalhaLlm; detalhe?: string } {
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return { motivo: 'credencial_invalida', detalhe: e.message }
  if (e instanceof Anthropic.RateLimitError) return { motivo: 'limite_de_taxa', detalhe: e.message }
  if (e instanceof Anthropic.BadRequestError) return { motivo: 'resposta_inesperada', detalhe: e.message }
  if (e instanceof Anthropic.APIError) return { motivo: 'indisponivel', detalhe: `${e.status ?? ''} ${e.message}`.trim() }
  if (e instanceof Error && (e.name === 'AbortError' || /abort/i.test(e.message))) return { motivo: 'indisponivel', detalhe: 'prazo do turno estourado' }
  return { motivo: 'indisponivel', detalhe: e instanceof Error ? e.message : String(e) }
}
