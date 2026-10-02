import type {
  PedidoDeLaco, PortaLlmFerramentas, ResultadoLaco, CapacidadesLlmFerramentas, ChamadaRegistrada, RastroDoLaco,
} from './porta-llm.js'
import type { MotivoFalhaLlm } from './porta.js'

/**
 * Adaptador OPENROUTER com laço de ferramentas — a RESERVA DE DISPONIBILIDADE
 * (ADR-023): mesma porta do Claude, fio OpenAI-compatível (`tool_calls` com
 * argumentos em string JSON, `response_format: json_schema`). Só este arquivo
 * conhece esse formato.
 *
 * ⚠️ `IA_MODELO` aceita lista separada por vírgula; o OpenRouter aceita no
 * máximo 3 em `models` (cadeia de fallback do PROVEDOR). O prefixo de cache
 * não migra entre fornecedores: usar isto por custo é ilusão; é para quando a
 * Anthropic está fora.
 */
const URL_COMPLETIONS = 'https://openrouter.ai/api/v1/chat/completions'
const MODELOS_POR_CHAMADA = 3

export interface ConfigOpenRouterFerramentas {
  readonly apiKey: string
  readonly modelos: readonly string[]
  readonly buscar?: typeof fetch | undefined
  readonly timeoutMs?: number | undefined
}

type MensagemFio =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ChamadaFio[] }
  | { role: 'tool'; tool_call_id: string; content: string }
interface ChamadaFio { id: string; type: 'function'; function: { name: string; arguments: string } }

export class LlmOpenRouterFerramentas implements PortaLlmFerramentas {
  readonly nome = 'openrouter'
  readonly capacidades: CapacidadesLlmFerramentas = { ferramentas: true, saidaEstruturada: true, cacheDePrefixo: false }
  readonly #modelos: readonly string[]
  readonly #buscar: typeof fetch
  readonly #timeoutMs: number
  constructor(private readonly cfg: ConfigOpenRouterFerramentas) {
    this.#modelos = cfg.modelos.map((m) => m.trim()).filter(Boolean).slice(0, MODELOS_POR_CHAMADA)
    this.#buscar = cfg.buscar ?? fetch
    this.#timeoutMs = cfg.timeoutMs ?? 45_000
  }

  async rodar(pedido: PedidoDeLaco): Promise<ResultadoLaco> {
    const inicio = Date.now()
    const chamadas: ChamadaRegistrada[] = []
    const uso = { entrada: 0, saida: 0, cacheLeitura: 0, cacheEscrita: 0 }
    let rodadas = 0
    let modeloUsado = pedido.modelo?.trim() || this.#modelos[0] || ''
    const rastro = (parouPor: RastroDoLaco['parouPor']): RastroDoLaco => ({ chamadas, rodadas, uso, modelo: modeloUsado, latenciaMs: Date.now() - inicio, parouPor })
    const prazo = new AbortController()
    const timer = setTimeout(() => prazo.abort(), Math.min(pedido.limites.prazoMs, this.#timeoutMs))

    const tools = pedido.ferramentas.map((f) => ({
      type: 'function' as const,
      function: { name: f.nome, description: f.descricao, parameters: f.esquema, strict: true },
    }))
    const mensagens: MensagemFio[] = [
      { role: 'system', content: pedido.sistema.map((b) => b.texto).join('\n\n') },
      ...paraFio(pedido.mensagens),
    ]
    const modelos = pedido.modelo?.trim() ? [pedido.modelo.trim()] : this.#modelos

    try {
      while (true) {
        rodadas += 1
        const ultima = rodadas >= pedido.limites.maxRodadas
        const corpo = {
          model: modelos[0],
          ...(modelos.length > 1 ? { models: modelos, route: 'fallback' } : {}),
          max_tokens: pedido.limites.maxTokensSaida,
          messages: mensagens,
          ...(tools.length ? { tools, tool_choice: ultima ? 'none' : 'auto' } : {}),
          response_format: { type: 'json_schema', json_schema: { name: 'resposta_do_agente', strict: true, schema: pedido.esquemaSaida } },
        }
        const r = await this.#buscar(URL_COMPLETIONS, {
          method: 'POST', signal: prazo.signal,
          headers: { authorization: `Bearer ${this.cfg.apiKey}`, 'content-type': 'application/json', 'x-title': 'GeraCRM' },
          body: JSON.stringify(corpo),
        })
        if (!r.ok) {
          const texto = await r.text().catch(() => '')
          return { ok: false, ...mapearStatus(r.status, texto), rastro: rastro('fim') }
        }
        const json = await r.json().catch(() => null) as RespostaFio | null
        if (!json || json.error) return { ok: false, motivo: 'indisponivel', detalhe: json?.error?.message ?? 'corpo vazio', rastro: rastro('fim') }
        modeloUsado = json.model ?? modeloUsado
        const u = json.usage
        if (u) {
          uso.entrada += u.prompt_tokens ?? 0; uso.saida += u.completion_tokens ?? 0
          uso.cacheLeitura += u.prompt_tokens_details?.cached_tokens ?? 0
        }
        const escolha = json.choices?.[0]
        const msg = escolha?.message
        if (!msg) return { ok: false, motivo: 'resposta_inesperada', detalhe: 'sem choices', rastro: rastro('fim') }
        if (escolha.finish_reason === 'length') return { ok: false, motivo: 'resposta_inesperada', detalhe: 'estourou o teto de tokens de saída', rastro: rastro('max_tokens') }
        if (escolha.finish_reason === 'content_filter') return { ok: false, motivo: 'conteudo_recusado', rastro: rastro('fim') }

        const chamadasFio = msg.tool_calls ?? []
        if (chamadasFio.length > 0 && !ultima) {
          mensagens.push({ role: 'assistant', content: msg.content ?? null, tool_calls: chamadasFio })
          for (const c of chamadasFio) {
            const t0 = Date.now()
            let entrada: unknown = {}
            try { entrada = c.function.arguments ? JSON.parse(c.function.arguments) : {} } catch { entrada = { _argumentos_invalidos: c.function.arguments } }
            const res = await pedido.executar(c.function.name, entrada)
            chamadas.push({ nome: c.function.name, entrada, saida: res.ok ? res.saida : null, ms: Date.now() - t0, ...(res.ok ? {} : { erro: res.erro }) })
            mensagens.push({ role: 'tool', tool_call_id: c.id, content: `<dados_externos>${JSON.stringify(res.ok ? res.saida : { erro: res.erro })}</dados_externos>` })
          }
          continue
        }
        const texto = (msg.content ?? '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '')
        try {
          return { ok: true, saida: JSON.parse(texto), rastro: rastro(ultima ? 'max_rodadas' : 'fim') }
        } catch {
          return { ok: false, motivo: 'resposta_inesperada', detalhe: `não veio JSON: ${texto.slice(0, 120)}`, rastro: rastro('fim') }
        }
      }
    } catch (e) {
      const detalhe = e instanceof Error ? e.message : String(e)
      return { ok: false, motivo: 'indisponivel', detalhe: prazo.signal.aborted ? 'prazo do turno estourado' : detalhe, rastro: rastro(prazo.signal.aborted ? 'prazo' : 'fim') }
    } finally {
      clearTimeout(timer)
    }
  }
}

interface RespostaFio {
  model?: string
  error?: { message?: string }
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
  choices?: { finish_reason?: string; message?: { content?: string | null; tool_calls?: ChamadaFio[] } }[]
}

function paraFio(falas: PedidoDeLaco['mensagens']): MensagemFio[] {
  const out: MensagemFio[] = []
  for (const f of falas) {
    if (f.papel === 'operador') { out.push({ role: 'system', content: f.texto }); continue }
    const role = f.papel === 'cliente' ? 'user' : 'assistant'
    const ultimo = out[out.length - 1]
    if (ultimo && ultimo.role === role && typeof ultimo.content === 'string') ultimo.content = `${ultimo.content}\n${f.texto}`
    else out.push(role === 'user' ? { role, content: f.texto } : { role, content: f.texto })
  }
  return out
}

function mapearStatus(status: number, texto: string): { motivo: MotivoFalhaLlm; detalhe: string } {
  const detalhe = `${status} ${texto.slice(0, 160)}`.trim()
  if (status === 401 || status === 403) return { motivo: 'credencial_invalida', detalhe }
  if (status === 402) return { motivo: 'limite_de_custo', detalhe }
  if (status === 429) return { motivo: 'limite_de_taxa', detalhe }
  if (status >= 500) return { motivo: 'indisponivel', detalhe }
  return { motivo: 'resposta_inesperada', detalhe }
}
