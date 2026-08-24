import type { CapacidadesCanal, PortaCanal, ResultadoEnvio, ResultadoAcaoMensagem } from './porta.js'

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
}

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

  /** POST à Graph API já com timeout + mapeamento de erro tipificado. */
  async #postar(payload: Record<string, unknown>): Promise<ResultadoEnvio> {
    const controle = new AbortController()
    const relogio = setTimeout(() => controle.abort(), this.#timeout)
    try {
      const resp = await this.#buscar(this.#url(), {
        method: 'POST',
        signal: controle.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#cred.token}` },
        body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...payload }),
      })

      if (resp.status === 401 || resp.status === 403) return { ok: false, motivo: 'credencial_invalida' }
      if (resp.status >= 500) return { ok: false, motivo: 'indisponivel', detalhe: `HTTP ${resp.status}` }

      const corpo = (await resp.json().catch(() => null)) as
        | { messages?: { id?: string }[]; error?: { message?: string; code?: number; error_subcode?: number } }
        | null

      if (!resp.ok || !corpo || corpo.error) {
        const err = corpo?.error
        const code = err?.code
        // 190 = token inválido/expirado; 10/200/803 = permissão.
        if (code === 190 || code === 10 || code === 200) return { ok: false, motivo: 'credencial_invalida', detalhe: err?.message }
        // 131030 = destino fora da lista permitida; 131026/131047 = não é WhatsApp / fora da janela.
        if (code === 131030 || code === 131026 || code === 131047 || code === 131051) {
          return { ok: false, motivo: 'destino_invalido', detalhe: err?.message }
        }
        // 131056/368/80007 = rate limit / throttle temporário — a ação é esperar.
        if (code === 131056 || code === 368 || code === 80007) return { ok: false, motivo: 'indisponivel', detalhe: err?.message }
        return { ok: false, motivo: 'resposta_inesperada', detalhe: err?.message ?? `HTTP ${resp.status}` }
      }

      const idExterno = corpo.messages?.[0]?.id
      if (!idExterno) return { ok: false, motivo: 'resposta_inesperada', detalhe: 'envio sem id' }
      return { ok: true, idExterno }
    } catch (erro) {
      if (erro instanceof Error && erro.name === 'AbortError') return { ok: false, motivo: 'indisponivel', detalhe: 'sem resposta no tempo' }
      return { ok: false, motivo: 'indisponivel', detalhe: erro instanceof Error ? erro.message : String(erro) }
    } finally {
      clearTimeout(relogio)
    }
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

  // ⚠️ Sem recall/edição na Cloud API — degrada honesto (não é falha, é limite).
  async apagarMensagem(): Promise<ResultadoAcaoMensagem> {
    return { ok: false, motivo: 'indisponivel', detalhe: 'WhatsApp Oficial não permite apagar mensagem via API' }
  }
  async editarMensagem(): Promise<ResultadoAcaoMensagem> {
    return { ok: false, motivo: 'indisponivel', detalhe: 'WhatsApp Oficial não permite editar mensagem via API' }
  }
}
