import type {
  PedidoDeLaco, PortaLlmFerramentas, ResultadoLaco, CapacidadesLlmFerramentas, ChamadaRegistrada, RastroDoLaco,
} from './porta-llm.js'
import type { MotivoFalhaLlm } from './porta.js'
import { SLOTS_QUALIFICACAO } from '@geracrm/shared'

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

/**
 * PRESETS de fornecedores OpenAI-compatíveis. O fio é o mesmo; o que muda é
 * URL, chave, e o que cada um aceita (cadeia `models`, `strict`).
 *
 * ⚠️ Modelos GRATUITOS costumam ignorar `response_format` e devolver texto cru,
 * ou recusar `strict`. O adaptador DEGRADA em vez de falhar: tenta json_schema,
 * depois json_object, depois sem formato — e texto cru vira uma mensagem.
 */
export const PRESETS = {
  openrouter: { url: URL_COMPLETIONS, cadeia: true, strict: true },
  groq: { url: 'https://api.groq.com/openai/v1/chat/completions', cadeia: false, strict: false },
  gemini: { url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', cadeia: false, strict: false },
  cerebras: { url: 'https://api.cerebras.ai/v1/chat/completions', cadeia: false, strict: false },
  maritaca: { url: 'https://chat.maritaca.ai/api/chat/completions', cadeia: false, strict: false },
} as const
export type PresetCompat = keyof typeof PRESETS

export interface ConfigOpenRouterFerramentas {
  readonly apiKey: string
  readonly modelos: readonly string[]
  readonly buscar?: typeof fetch | undefined
  readonly timeoutMs?: number | undefined
  /** Fornecedor OpenAI-compatível. Padrão: openrouter. */
  readonly preset?: PresetCompat | undefined
  /** URL alternativa (qualquer endpoint `chat/completions` compatível). */
  readonly url?: string | undefined
}

type MensagemFio =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ChamadaFio[] }
  | { role: 'tool'; tool_call_id: string; content: string }
interface ChamadaFio { id: string; type: 'function'; function: { name: string; arguments: string } }

export class LlmOpenRouterFerramentas implements PortaLlmFerramentas {
  readonly nome: string
  readonly capacidades: CapacidadesLlmFerramentas = { ferramentas: true, saidaEstruturada: true, cacheDePrefixo: false }
  readonly #modelos: readonly string[]
  readonly #buscar: typeof fetch
  readonly #timeoutMs: number
  readonly #preset: (typeof PRESETS)[PresetCompat]
  readonly #url: string
  constructor(private readonly cfg: ConfigOpenRouterFerramentas) {
    const preset = cfg.preset ?? 'openrouter'
    this.nome = preset
    this.#preset = PRESETS[preset]
    this.#url = cfg.url?.trim() || this.#preset.url
    this.#modelos = cfg.modelos.map((m) => m.trim()).filter(Boolean).slice(0, this.#preset.cadeia ? MODELOS_POR_CHAMADA : 1)
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
      function: { name: f.nome, description: f.descricao, parameters: f.esquema, ...(this.#preset.strict ? { strict: true } : {}) },
    }))
    // ⚠️ O esquema vai ESCRITO no system também: modelo gratuito que ignora
    //    `response_format` ainda sabe o que devolver.
    const mensagens: MensagemFio[] = [
      { role: 'system', content: pedido.sistema.map((b) => b.texto).join('\n\n') + `\n\n<formato_obrigatorio>Responda SOMENTE com um objeto JSON válido, sem texto fora dele, neste formato: {"mensagens":["texto da primeira bolha","(opcional) segunda bolha"],"confianca":0.9,"fase":"descoberta|recomendacao|proposta|fechamento|handoff","handoff":{"motivo":"...","resumo":"..."} (opcional),"slots":{"cidade":"..."} (opcional; só chaves ${SLOTS_QUALIFICACAO.join('|')} e só o que o cliente disse)}</formato_obrigatorio>` },
      ...paraFio(pedido.mensagens),
    ]
    const modelos = pedido.modelo?.trim() ? [pedido.modelo.trim()] : this.#modelos
    // Formato: json_schema → json_object → nenhum (cada 400 por formato desce um degrau).
    let formato: 'json_schema' | 'json_object' | 'nenhum' = 'json_schema'

    try {
      while (true) {
        rodadas += 1
        const ultima = rodadas >= pedido.limites.maxRodadas
        const corpo = {
          model: modelos[0],
          ...(this.#preset.cadeia && modelos.length > 1 ? { models: modelos, route: 'fallback' } : {}),
          max_tokens: pedido.limites.maxTokensSaida,
          messages: mensagens,
          ...(tools.length ? { tools, tool_choice: ultima ? 'none' : 'auto' } : {}),
          ...(formato === 'json_schema' ? { response_format: { type: 'json_schema', json_schema: { name: 'resposta_do_agente', strict: true, schema: pedido.esquemaSaida } } }
            : formato === 'json_object' ? { response_format: { type: 'json_object' } } : {}),
        }
        const r = await this.#buscar(this.#url, {
          method: 'POST', signal: prazo.signal,
          headers: { authorization: `Bearer ${this.cfg.apiKey}`, 'content-type': 'application/json', 'x-title': 'GeraCRM' },
          body: JSON.stringify(corpo),
        })
        if (!r.ok) {
          const texto = await r.text().catch(() => '')
          // Fornecedor recusou o FORMATO (ou o strict/tools): desce um degrau e repete a rodada.
          if (formato !== 'nenhum' && recusouFormato(texto)) {
            formato = formato === 'json_schema' ? 'json_object' : 'nenhum'
            rodadas -= 1
            continue
          }
          return { ok: false, ...mapearStatus(r.status, texto), rastro: rastro('fim') }
        }
        const json = await r.json().catch(() => null) as RespostaFio | null
        if (json?.error) {
          // OpenRouter devolve 200 com `error` quando o fornecedor de trás recusa — inclusive o
          // schema ("Grammar error: Unimplemented keys"). Mesmo tratamento: desce o formato.
          if (formato !== 'nenhum' && recusouFormato(json.error.message ?? '')) {
            formato = formato === 'json_schema' ? 'json_object' : 'nenhum'
            rodadas -= 1
            continue
          }
          return { ok: false, motivo: 'indisponivel', detalhe: json.error.message ?? 'erro do fornecedor', rastro: rastro('fim') }
        }
        if (!json) return { ok: false, motivo: 'indisponivel', detalhe: 'corpo vazio', rastro: rastro('fim') }
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
        const texto = (msg.content ?? '').trim()
        const saida = interpretarSaida(texto)
        if (!saida) return { ok: false, motivo: 'resposta_inesperada', detalhe: 'resposta vazia', rastro: rastro('fim') }
        return { ok: true, saida, rastro: rastro(ultima ? 'max_rodadas' : 'fim') }
      }
    } catch (e) {
      const detalhe = e instanceof Error ? e.message : String(e)
      return { ok: false, motivo: 'indisponivel', detalhe: prazo.signal.aborted ? 'prazo do turno estourado' : detalhe, rastro: rastro(prazo.signal.aborted ? 'prazo' : 'fim') }
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * O que o modelo devolveu → a saída que o domínio valida.
 *
 * ⚠️ Modelo gratuito: às vezes JSON com cerca de markdown, às vezes JSON com
 * outro nome de campo, às vezes TEXTO CRU. Tudo isso vira `{mensagens:[…]}` —
 * o guardrail numérico e a validação de confiança continuam valendo no turno.
 * Devolve null só para resposta vazia.
 */
export function interpretarSaida(texto: string): unknown {
  const limpo = texto.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()
  if (!limpo) return null
  const candidato = extrairJson(limpo)
  if (candidato && typeof candidato === 'object' && !Array.isArray(candidato)) {
    const o = { ...(candidato as Record<string, unknown>) }
    if ('slots' in o) {
      const slots = normalizarSlots(o['slots'])
      if (slots) o['slots'] = slots
      else delete o['slots']
    }
    const brutas = o['mensagens'] ?? o['messages'] ?? o['respostas']
    const mensagens = normalizarMensagens(Array.isArray(brutas) ? brutas : brutas !== undefined ? [brutas] : [])
    if (mensagens.length > 0) return { ...o, mensagens, confianca: normalizarConfianca(o['confianca']) }
    const texto1 = ['texto', 'resposta', 'mensagem', 'message', 'content', 'reply', 'answer'].map((k) => o[k]).find((v) => typeof v === 'string' && v.trim())
    if (typeof texto1 === 'string') return { ...o, mensagens: [texto1.trim()], confianca: normalizarConfianca(o['confianca'], 0.6) }
  }
  if (Array.isArray(candidato)) {
    const mensagens = normalizarMensagens(candidato)
    if (mensagens.length > 0) return { mensagens, confianca: 0.6 }
  }
  // Texto cru: vira UMA mensagem com confiança baixa (o modelo não seguiu o formato).
  return { mensagens: [limpo.slice(0, 1200)], confianca: 0.6 }
}

/**
 * O fornecedor recusou o FORMATO (response_format, strict, ou o próprio JSON Schema —
 * "Grammar error", "Unimplemented keys", "schema"), e não a requisição em si.
 */
function recusouFormato(texto: string): boolean {
  return /response_format|json_schema|json_object|strict|structured|grammar|schema|propertyNames|unimplemented keys/i.test(texto)
}

/**
 * `slots` como o modelo gratuito manda: `{}`, nulos, chave inventada, número.
 * Fica só chave conhecida com texto não vazio — o resto é como se não tivesse vindo.
 */
function normalizarSlots(bruto: unknown): Record<string, string> | undefined {
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) return undefined
  const out: Record<string, string> = {}
  for (const chave of SLOTS_QUALIFICACAO) {
    const v = (bruto as Record<string, unknown>)[chave]
    const t = typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : ''
    if (t) out[chave] = t.slice(0, 120)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * `mensagens` como o modelo gratuito manda: strings, objetos {texto|text|content},
 * números, nulos no meio. Fica só o que é texto não vazio, no máximo 3.
 */
function normalizarMensagens(brutas: readonly unknown[]): string[] {
  const out: string[] = []
  for (const m of brutas) {
    let t: string | null = null
    if (typeof m === 'string') t = m
    else if (typeof m === 'number') t = String(m)
    else if (m && typeof m === 'object') {
      const o = m as Record<string, unknown>
      const v = ['texto', 'text', 'content', 'mensagem', 'message', 'body'].map((k) => o[k]).find((x) => typeof x === 'string')
      if (typeof v === 'string') t = v
    }
    if (t && t.trim()) out.push(t.trim().slice(0, 1200))
    if (out.length === 3) break
  }
  return out
}

function normalizarConfianca(v: unknown, padrao = 0.7): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(',', '.')) : NaN
  if (!Number.isFinite(n)) return padrao
  return n > 1 ? Math.min(n / 100, 1) : Math.max(n, 0)
}

function extrairJson(texto: string): unknown {
  try { return JSON.parse(texto) } catch { /* segue */ }
  const ini = texto.indexOf('{'), fim = texto.lastIndexOf('}')
  if (ini >= 0 && fim > ini) {
    try { return JSON.parse(texto.slice(ini, fim + 1)) } catch { /* segue */ }
  }
  return null
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
