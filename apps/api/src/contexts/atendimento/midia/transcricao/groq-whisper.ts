import type { AudioParaTranscrever, PortaTranscricao, ResultadoTranscricao } from './porta.js'

/**
 * Adaptador de transcrição via API HTTP compatível com OpenAI (`/audio/
 * transcriptions`, multipart). O padrão é o Groq com Whisper — rápido e barato
 * para áudio curto de WhatsApp — mas a URL e o modelo são parâmetros: trocar de
 * provedor compatível é trocar duas strings, não o adaptador.
 *
 * ⚠️ Nunca chamado em teste: `buscar` é injetável e mockado por contrato.
 */
export interface OpcoesGroqWhisper {
  readonly apiKey: string
  readonly modelo?: string | undefined
  readonly url?: string | undefined
  readonly buscar?: typeof fetch | undefined
  readonly timeoutMs?: number | undefined
}

export const URL_GROQ_TRANSCRICAO = 'https://api.groq.com/openai/v1/audio/transcriptions'
export const MODELO_GROQ_PADRAO = 'whisper-large-v3-turbo'
/** Teto do provedor para upload de áudio (25 MB no Groq/OpenAI). */
const LIMITE_BYTES_PROVEDOR = 25 * 1024 * 1024

const EXT_POR_MIME: Record<string, string> = {
  'audio/ogg': 'ogg', 'audio/opus': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac',
  'audio/webm': 'webm', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac',
}

export class TranscricaoGroqWhisper implements PortaTranscricao {
  readonly nome = 'groq-whisper'
  readonly capacidades = { transcreve: true } as const

  readonly #o: OpcoesGroqWhisper
  constructor(o: OpcoesGroqWhisper) { this.#o = o }

  async transcrever(audio: AudioParaTranscrever): Promise<ResultadoTranscricao> {
    if (audio.bytes.length === 0) return { ok: false, motivo: 'formato', detalhe: 'áudio vazio' }
    if (audio.bytes.length > LIMITE_BYTES_PROVEDOR) return { ok: false, motivo: 'muito_longo', detalhe: `${audio.bytes.length} bytes` }

    // ⚠️ `codecs=opus` e afins saem do mime: a extensão é o que o provedor usa
    //    para reconhecer o contêiner.
    const mimeBase = audio.mime.split(';')[0]!.trim().toLowerCase()
    const ext = EXT_POR_MIME[mimeBase]
    if (!ext) return { ok: false, motivo: 'formato', detalhe: `mime ${mimeBase}` }

    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(audio.bytes)], { type: mimeBase }), `audio.${ext}`)
    form.append('model', this.#o.modelo ?? MODELO_GROQ_PADRAO)
    form.append('response_format', 'verbose_json')
    if (audio.idioma) form.append('language', audio.idioma)

    const controle = new AbortController()
    const relogio = setTimeout(() => controle.abort(), this.#o.timeoutMs ?? 60_000)
    try {
      const resp = await (this.#o.buscar ?? fetch)(this.#o.url ?? URL_GROQ_TRANSCRICAO, {
        method: 'POST', signal: controle.signal,
        headers: { authorization: `Bearer ${this.#o.apiKey}` },
        body: form,
      })
      if (resp.status === 401 || resp.status === 403) return { ok: false, motivo: 'credencial_invalida' }
      if (resp.status === 413) return { ok: false, motivo: 'muito_longo', detalhe: 'HTTP 413' }
      if (resp.status === 429 || resp.status >= 500) return { ok: false, motivo: 'indisponivel', detalhe: `HTTP ${resp.status}` }
      const corpo = (await resp.json().catch(() => null)) as
        | { text?: string; language?: string; duration?: number; error?: { message?: string; type?: string } }
        | null
      if (!resp.ok || !corpo || typeof corpo.text !== 'string') {
        const msg = corpo?.error?.message ?? `HTTP ${resp.status}`
        // 400 do provedor em geral é arquivo que ele não decodifica.
        return { ok: false, motivo: resp.status === 400 ? 'formato' : 'indisponivel', detalhe: msg }
      }
      return {
        ok: true, texto: corpo.text.trim(),
        idioma: corpo.language ?? undefined,
        duracaoS: typeof corpo.duration === 'number' ? corpo.duration : undefined,
      }
    } catch (erro) {
      if (erro instanceof Error && erro.name === 'AbortError') return { ok: false, motivo: 'indisponivel', detalhe: 'sem resposta no tempo' }
      return { ok: false, motivo: 'indisponivel', detalhe: erro instanceof Error ? erro.message : String(erro) }
    } finally {
      clearTimeout(relogio)
    }
  }
}
