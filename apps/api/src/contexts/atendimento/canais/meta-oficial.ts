import type {
  CapacidadesCanal, PortaCanal, ResultadoEnvio, ResultadoAcaoMensagem, BotaoResposta, ResultadoMidiaBaixada,
} from './porta.js'
import { LIMITE_BYTES } from '../midia/dataurl.js'

/**
 * Adaptador do WhatsApp Oficial (Meta Cloud API) atrás da PortaCanal.
 *
 * ⚠️ O gateway de saída revalida janela/opt-out/bloqueio ANTES de chamar isto —
 * o adaptador só entrega à Graph API. Falha vira retorno TIPIFICADO, nunca
 * exceção. A Meta é sempre mockada em teste (fetch injetável).
 *
 * ⚠️ Capacidades HONESTAS: a Cloud API não apaga nem edita mensagem enviada
 * (não existe recall na API), e mídia exige upload prévio — degradamos com
 * motivo claro em vez de fingir que funcionou.
 */
export interface CredencialMetaOficial {
  readonly phoneNumberId: string
  readonly token: string
}

const API_VERSION = 'v21.0'
const BASE = 'https://graph.facebook.com'

export const CAPACIDADES_META_OFICIAL: CapacidadesCanal = {
  janela24h: true,
  aceitaTemplate: true,
  riscoBanimento: false,
  sessaoPodeCair: false,
  textoLivreSempre: false,
  // Cloud API: `typing_indicator` (marca lida + digitando) e mensagens
  // interativas (até 3 botões de resposta).
  indicaDigitacao: true,
  mensagensInterativas: true,
}

/** Teto da Cloud API: 3 botões por mensagem, título com até 20 caracteres. */
export const MAX_BOTOES_META = 3
const MAX_TITULO_BOTAO = 20

/** Prefixo com que a ingestão guarda a mídia da Meta ANTES de baixar (só o id). */
export const PREFIXO_MIDIA_META = 'meta:media:'

export class CanalMetaOficial implements PortaCanal {
  /**
   * ⚠️ O oficial não tem sessão que caia — é token. Se o token morrer, o ENVIO
   * falha com motivo tipificado, que é onde isso deve aparecer. Responder aqui
   * exigiria uma chamada à Graph API só para dizer "provavelmente sim", e o vigia
   * nem pergunta (`sessaoPodeCair: false`).
   */
  async verificarConexao(): Promise<{ conectado: boolean; detalhe?: string | undefined }> {
    return { conectado: true, detalhe: 'canal oficial não usa sessão — o token é validado no envio' }
  }

  /** ⚠️ Não há QR no oficial: reconectar ali é trocar o token no cadastro. */
  async qrCode(): Promise<{ ok: true; imagemDataUrl: string } | { ok: false; motivo: string }> {
    return { ok: false, motivo: 'o canal oficial não usa QR — atualize o token no cadastro do número' }
  }

  readonly tipo = 'whatsapp_oficial' as const
  readonly capacidades = CAPACIDADES_META_OFICIAL

  readonly #cred: CredencialMetaOficial
  readonly #buscar: typeof fetch
  readonly #timeout: number

  constructor(cred: CredencialMetaOficial, opcoes: { buscar?: typeof fetch; timeoutMs?: number } = {}) {
    this.#cred = cred
    this.#buscar = opcoes.buscar ?? fetch
    this.#timeout = opcoes.timeoutMs ?? 15_000
  }

  #url(): string {
    return `${BASE}/${API_VERSION}/${encodeURIComponent(this.#cred.phoneNumberId)}/messages`
  }

  /**
   * Chamada à Graph API com timeout e corpo já parseado. Erro de REDE vira
   * `{ status: 0 }` — quem chama mapeia para o motivo tipificado.
   */
  async #chamar(url: string, init: RequestInit): Promise<{ status: number; corpo: unknown; detalhe?: string }> {
    const controle = new AbortController()
    const relogio = setTimeout(() => controle.abort(), this.#timeout)
    try {
      const resp = await this.#buscar(url, {
        ...init, signal: controle.signal,
        headers: { authorization: `Bearer ${this.#cred.token}`, ...(init.headers as Record<string, string> | undefined) },
      })
      const corpo = await resp.json().catch(() => null)
      return { status: resp.status, corpo }
    } catch (erro) {
      if (erro instanceof Error && erro.name === 'AbortError') return { status: 0, corpo: null, detalhe: 'sem resposta no tempo' }
      return { status: 0, corpo: null, detalhe: erro instanceof Error ? erro.message : String(erro) }
    } finally {
      clearTimeout(relogio)
    }
  }

  /** Mapeia status/corpo de erro da Graph API para o motivo tipificado. */
  #falha(status: number, corpo: unknown, detalhe?: string): ResultadoEnvio & { ok: false } {
    if (status === 0) return { ok: false, motivo: 'indisponivel', detalhe }
    if (status === 401 || status === 403) return { ok: false, motivo: 'credencial_invalida' }
    if (status >= 500) return { ok: false, motivo: 'indisponivel', detalhe: `HTTP ${status}` }
    const err = (corpo as { error?: { message?: string; code?: number } } | null)?.error
    const code = err?.code
    // 190 = token inválido/expirado; 10/200/803 = permissão.
    if (code === 190 || code === 10 || code === 200) return { ok: false, motivo: 'credencial_invalida', detalhe: err?.message }
    // 131030 = destino fora da lista permitida; 131026/131047 = não é WhatsApp / fora da janela.
    if (code === 131030 || code === 131026 || code === 131047 || code === 131051) {
      return { ok: false, motivo: 'destino_invalido', detalhe: err?.message }
    }
    // 131056/368/80007 = rate limit / throttle temporário — a ação é esperar.
    if (code === 131056 || code === 368 || code === 80007) return { ok: false, motivo: 'indisponivel', detalhe: err?.message }
    return { ok: false, motivo: 'resposta_inesperada', detalhe: err?.message ?? `HTTP ${status}` }
  }

  /** POST de MENSAGEM à Graph API: espera `messages[0].id` de volta. */
  async #postar(payload: Record<string, unknown>): Promise<ResultadoEnvio> {
    const r = await this.#chamar(this.#url(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...payload }),
    })
    const corpo = r.corpo as { messages?: { id?: string }[]; error?: unknown } | null
    if (r.status < 200 || r.status >= 300 || !corpo || corpo.error) return this.#falha(r.status, r.corpo, r.detalhe)
    const idExterno = corpo.messages?.[0]?.id
    if (!idExterno) return { ok: false, motivo: 'resposta_inesperada', detalhe: 'envio sem id' }
    return { ok: true, idExterno }
  }

  async enviarTexto(paraE164: string, texto: string): Promise<ResultadoEnvio> {
    return this.#postar({ to: paraE164.replace(/^\+/, ''), type: 'text', text: { preview_url: false, body: texto } })
  }

  async enviarImagem(paraE164: string, imagem: string, legenda?: string): Promise<ResultadoEnvio> {
    // ⚠️ A Cloud API aceita URL pública (`link`) ou um media id de upload prévio.
    //    Data URL (base64) exige o passo de upload — ainda não implementado.
    if (!/^https?:\/\//i.test(imagem)) {
      return { ok: false, motivo: 'indisponivel', detalhe: 'imagem por upload ainda não implementada no Oficial' }
    }
    return this.#postar({ to: paraE164.replace(/^\+/, ''), type: 'image', image: { link: imagem, ...(legenda ? { caption: legenda } : {}) } })
  }

  async enviarAudio(paraE164: string, audio: string): Promise<ResultadoEnvio> {
    if (!/^https?:\/\//i.test(audio)) {
      return { ok: false, motivo: 'indisponivel', detalhe: 'áudio por upload ainda não implementado no Oficial' }
    }
    return this.#postar({ to: paraE164.replace(/^\+/, ''), type: 'audio', audio: { link: audio } })
  }

  /**
   * "Digitando…" + marca a mensagem do cliente como lida, numa chamada só —
   * é o formato da Cloud API (`status: read` + `typing_indicator`). Sem o id da
   * mensagem do cliente a Meta recusa; aí não há o que mostrar e saímos quietos.
   *
   * ⚠️ Best-effort por contrato: nunca lança. O indicador some sozinho em ~25 s
   * ou quando a resposta chega.
   */
  async indicarDigitacao(_paraE164: string, mensagemIdExterno?: string): Promise<void> {
    if (!mensagemIdExterno) return
    await this.#chamar(this.#url(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', status: 'read', message_id: mensagemIdExterno,
        typing_indicator: { type: 'text' },
      }),
    })
  }

  /**
   * Texto com botões de resposta rápida (`interactive.type = button`). A Cloud
   * API aceita no máximo 3 botões com título de até 20 caracteres — além disso
   * truncamos/cortamos aqui, para o chamador não precisar conhecer o limite.
   */
  async enviarBotoes(paraE164: string, texto: string, botoes: readonly BotaoResposta[]): Promise<ResultadoEnvio> {
    const lista = botoes.slice(0, MAX_BOTOES_META)
    if (lista.length === 0) return this.enviarTexto(paraE164, texto)
    return this.#postar({
      to: paraE164.replace(/^\+/, ''),
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: texto },
        action: {
          buttons: lista.map((b) => ({ type: 'reply', reply: { id: b.id.slice(0, 256), title: b.titulo.slice(0, MAX_TITULO_BOTAO) } })),
        },
      },
    })
  }

  /**
   * Baixa uma mídia de ENTRADA: `GET /{media_id}` devolve a URL (assinada, curta),
   * e a URL só responde com o MESMO bearer. Dois passos, os dois com o token.
   *
   * ⚠️ Fora do caminho da requisição: o webhook ingere com o placeholder
   * `meta:media:<id>` e isto roda depois do 200 (ou no worker de transcrição).
   */
  async baixarMidia(idMidia: string): Promise<ResultadoMidiaBaixada> {
    const meta = await this.#chamar(`${BASE}/${API_VERSION}/${encodeURIComponent(idMidia)}`, { method: 'GET' })
    const info = meta.corpo as { url?: string; mime_type?: string; file_size?: number; error?: { code?: number } } | null
    if (meta.status === 404 || info?.error?.code === 100) return { ok: false, motivo: 'nao_encontrada' }
    if (meta.status < 200 || meta.status >= 300 || !info?.url) return this.#falha(meta.status, meta.corpo, meta.detalhe)
    if (info.file_size && info.file_size > LIMITE_BYTES) return { ok: false, motivo: 'muito_grande' }

    const controle = new AbortController()
    const relogio = setTimeout(() => controle.abort(), this.#timeout)
    try {
      const resp = await this.#buscar(info.url, { method: 'GET', signal: controle.signal, headers: { authorization: `Bearer ${this.#cred.token}` } })
      if (resp.status === 401 || resp.status === 403) return { ok: false, motivo: 'credencial_invalida' }
      if (resp.status === 404) return { ok: false, motivo: 'nao_encontrada' }
      if (!resp.ok) return { ok: false, motivo: 'indisponivel', detalhe: `HTTP ${resp.status}` }
      const bytes = Buffer.from(await resp.arrayBuffer())
      if (bytes.length === 0) return { ok: false, motivo: 'resposta_inesperada', detalhe: 'mídia vazia' }
      if (bytes.length > LIMITE_BYTES) return { ok: false, motivo: 'muito_grande' }
      return { ok: true, bytes, mime: info.mime_type ?? resp.headers.get('content-type') ?? 'application/octet-stream' }
    } catch (erro) {
      if (erro instanceof Error && erro.name === 'AbortError') return { ok: false, motivo: 'indisponivel', detalhe: 'sem resposta no tempo' }
      return { ok: false, motivo: 'indisponivel', detalhe: erro instanceof Error ? erro.message : String(erro) }
    } finally {
      clearTimeout(relogio)
    }
  }

  // ⚠️ Sem recall/edição na Cloud API — degrada honesto (não é falha, é limite).
  async apagarMensagem(): Promise<ResultadoAcaoMensagem> {
    return { ok: false, motivo: 'indisponivel', detalhe: 'WhatsApp Oficial não permite apagar mensagem via API' }
  }
  async editarMensagem(): Promise<ResultadoAcaoMensagem> {
    return { ok: false, motivo: 'indisponivel', detalhe: 'WhatsApp Oficial não permite editar mensagem via API' }
  }
}
