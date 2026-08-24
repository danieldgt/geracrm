import type {
  PortaCanal, CapacidadesCanal, ResultadoEnvio, EventoWebhook, ResultadoAcaoMensagem,
} from './porta.js'

/**
 * Traduz o webhook cru do PlugZapi (formato Z-API) para o nosso evento.
 *
 * ⚠️ Formato Z-API `ReceivedCallback`: `phone`, `messageId`, `text.message`,
 * `senderName`, `fromMe`, `momment` (epoch ms), `isGroup`. Só mensagem de TEXTO
 * ENTRANTE (não `fromMe`, não grupo) vira conversa por ora — mídia e grupo são
 * ignorados com motivo (mas 200, senão o PlugZapi reenvia).
 *
 * ⚠️ Função pura e exportada: testável sem rede, e é onde mora todo o formato do
 * fornecedor — se um campo `text.message` vazar para o domínio, a porta quebrou.
 */
export function parseWebhookPlugZapi(corpo: unknown): EventoWebhook {
  const c = (corpo ?? {}) as Record<string, unknown>

  // Status de entrega de uma mensagem NOSSA (os dois tiques). Z-API manda
  // `MessageStatusCallback`/`DeliveryCallback` com `status` e os ids afetados.
  if (c['type'] === 'MessageStatusCallback' || c['type'] === 'DeliveryCallback') {
    const st = String(c['status'] ?? '').toUpperCase()
    const ids = Array.isArray(c['ids']) ? (c['ids'] as unknown[]) : c['id'] ? [c['id']] : []
    const idExterno = String(ids[0] ?? '')
    // READ/PLAYED = lida (azul); RECEIVED/DELIVERY_ACK = entregue (cinza duplo);
    // SENT = enviada (um tique). Outros (ex.: ERROR) não mexem no tique.
    const status =
      st === 'READ' || st === 'PLAYED' ? 'lida'
      : st === 'RECEIVED' || st === 'DELIVERY_ACK' ? 'entregue'
      : st === 'SENT' ? 'enviada'
      : null
    if (!idExterno || !status) return { tipo: 'ignorado', motivo: `status ${st || 'sem id'}` }
    return { tipo: 'status_mensagem', idExterno, status }
  }

  // Só o callback de mensagem recebida. Presença, conexão, etc. saem.
  if (c['type'] !== undefined && c['type'] !== 'ReceivedCallback') {
    return { tipo: 'ignorado', motivo: `type=${String(c['type'])}` }
  }
  if (c['fromMe'] === true) return { tipo: 'ignorado', motivo: 'mensagem própria (fromMe)' }
  if (c['isGroup'] === true) return { tipo: 'ignorado', motivo: 'mensagem de grupo' }

  const deE164 = String(c['phone'] ?? '').replace(/\D/g, '')
  const idExterno = String(c['messageId'] ?? '')
  if (!deE164 || !idExterno) return { tipo: 'ignorado', motivo: 'sem telefone ou messageId' }

  const ms = Number(c['momment'])
  const recebidaEm = Number.isFinite(ms) && ms > 0 ? new Date(ms) : new Date()
  const nomeRemetente = typeof c['senderName'] === 'string' ? (c['senderName'] as string) : undefined
  const base = { deE164, idExterno, recebidaEm, ...(nomeRemetente ? { nomeRemetente } : {}) }

  // Imagem: Z-API traz { image: { imageUrl, caption, mimeType } }.
  const img = c['image'] as Record<string, unknown> | undefined
  if (img && img['imageUrl']) {
    return {
      tipo: 'mensagem_entrante',
      mensagem: {
        ...base, tipo: 'imagem', midiaUrl: String(img['imageUrl']),
        mime: img['mimeType'] ? String(img['mimeType']) : undefined,
        texto: img['caption'] ? String(img['caption']) : undefined,
      },
    }
  }

  // Áudio (mensagem de voz): { audio: { audioUrl, mimeType } }.
  const aud = c['audio'] as Record<string, unknown> | undefined
  if (aud && aud['audioUrl']) {
    return {
      tipo: 'mensagem_entrante',
      mensagem: {
        ...base, tipo: 'audio', midiaUrl: String(aud['audioUrl']),
        mime: aud['mimeType'] ? String(aud['mimeType']) : undefined,
      },
    }
  }

  const texto = String(((c['text'] ?? {}) as Record<string, unknown>)['message'] ?? '')
  if (!texto) return { tipo: 'ignorado', motivo: 'tipo de mídia ainda não suportado' }

  return { tipo: 'mensagem_entrante', mensagem: { ...base, tipo: 'texto', texto } }
}

/**
 * Adaptador PlugZapi (Z-API) — canal WhatsApp NÃO-OFICIAL (ADR-021).
 *
 * ⚠️ Automatiza um WhatsApp Web via instância+token. NÃO tem janela de 24h nem
 * template — envia texto livre a qualquer hora. E **carrega risco de banimento
 * do número**: é decisão de negócio do cliente, declarada nas capacidades para
 * a interface avisar.
 *
 * ⚠️ Tudo específico do fornecedor mora AQUI. Se um campo `zaapId`/`messageId`
 * vazar para o domínio, a abstração de canal quebrou — e o adaptador Meta prova
 * isso da pior forma.
 *
 * API: `POST /instances/{instance}/token/{token}/send-text`, header
 * `Client-Token: {clientToken}`, corpo `{ phone, message }`. Confirmado no fonte
 * do pdv-core (`api.plugzapi.com.br/instances/`) — a validação ao vivo fecha.
 */

export interface CredencialPlugZapi {
  readonly instancia: string
  readonly token: string
  /** A "chave" de segurança da conta (header `Client-Token`). ⚠️ OPCIONAL: só
   *  as contas com "Account security token" ligado exigem. Sem ela, não manda o
   *  header. */
  readonly clientToken?: string | undefined
}

const BASE = 'https://api.plugzapi.com.br'

export const CAPACIDADES_PLUGZAPI: CapacidadesCanal = {
  janela24h: false,        // ⚠️ sem janela — é WhatsApp Web, não Cloud API
  aceitaTemplate: false,
  riscoBanimento: true,
  sessaoPodeCair: true,    // ⚠️ o alerta que a tela mostra
  textoLivreSempre: true,
}

export class CanalPlugZapi implements PortaCanal {
  readonly tipo = 'whatsapp_nao_oficial' as const
  readonly capacidades = CAPACIDADES_PLUGZAPI

  readonly #cred: CredencialPlugZapi
  readonly #buscar: typeof fetch
  readonly #timeout: number

  constructor(cred: CredencialPlugZapi, opcoes: { buscar?: typeof fetch; timeoutMs?: number } = {}) {
    this.#cred = cred
    this.#buscar = opcoes.buscar ?? fetch
    this.#timeout = opcoes.timeoutMs ?? 15_000
  }

  #url(caminho: string): string {
    return `${BASE}/instances/${encodeURIComponent(this.#cred.instancia)}` +
      `/token/${encodeURIComponent(this.#cred.token)}/${caminho}`
  }

  /** Header do Client-Token só quando a conta exige. */
  #cabecalhos(base: Record<string, string> = {}): Record<string, string> {
    return this.#cred.clientToken ? { ...base, 'client-token': this.#cred.clientToken } : base
  }

  async enviarTexto(paraE164: string, texto: string): Promise<ResultadoEnvio> {
    const controle = new AbortController()
    const relogio = setTimeout(() => controle.abort(), this.#timeout)
    try {
      const resp = await this.#buscar(this.#url('send-text'), {
        method: 'POST',
        signal: controle.signal,
        headers: this.#cabecalhos({ 'content-type': 'application/json' }),
        // ⚠️ `phone` é E.164 SEM `+` (padrão do WhatsApp/Z-API).
        body: JSON.stringify({ phone: paraE164.replace(/^\+/, ''), message: texto }),
      })

      // 401/403 = credencial (token/client-token) recusada.
      if (resp.status === 401 || resp.status === 403) {
        return { ok: false, motivo: 'credencial_invalida' }
      }
      if (resp.status >= 500) return { ok: false, motivo: 'indisponivel', detalhe: `HTTP ${resp.status}` }

      const corpo = (await resp.json().catch(() => null)) as Record<string, unknown> | null

      if (!resp.ok || !corpo) {
        // ⚠️ O PlugZapi devolve `error` com a causa; "instância desconectada" é o
        //    caso mais comum (celular desligado) e pede AÇÃO diferente de "número
        //    inválido" — por isso mapeado, não colapsado em "erro".
        const erro = String(corpo?.['error'] ?? corpo?.['message'] ?? '').toLowerCase()
        if (/connect|conect|disconnect|desconect|not connected|smartphone/.test(erro)) {
          return { ok: false, motivo: 'canal_desconectado', detalhe: 'instância não conectada (celular?)' }
        }
        if (/phone|number|número|invalid.*phone|not.*whatsapp|exist/.test(erro)) {
          return { ok: false, motivo: 'destino_invalido' }
        }
        return { ok: false, motivo: 'resposta_inesperada', detalhe: erro || `HTTP ${resp.status}` }
      }

      // Sucesso: o id da mensagem para dedup/rastreio (guardado como id_externo).
      const idExterno = String(corpo['messageId'] ?? corpo['zaapId'] ?? corpo['id'] ?? '')
      if (!idExterno) return { ok: false, motivo: 'resposta_inesperada', detalhe: 'envio sem id' }
      return { ok: true, idExterno }
    } catch (erro) {
      if (erro instanceof Error && erro.name === 'AbortError') {
        return { ok: false, motivo: 'indisponivel', detalhe: 'sem resposta no tempo' }
      }
      return { ok: false, motivo: 'indisponivel', detalhe: erro instanceof Error ? erro.message : String(erro) }
    } finally {
      clearTimeout(relogio)
    }
  }

  /** Envia imagem (URL ou data URL base64) — Z-API `send-image`. */
  async enviarImagem(paraE164: string, imagem: string, legenda?: string): Promise<ResultadoEnvio> {
    const controle = new AbortController()
    const relogio = setTimeout(() => controle.abort(), this.#timeout)
    try {
      const resp = await this.#buscar(this.#url('send-image'), {
        method: 'POST',
        signal: controle.signal,
        headers: this.#cabecalhos({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          phone: paraE164.replace(/^\+/, ''),
          image: imagem,
          ...(legenda ? { caption: legenda } : {}),
        }),
      })
      if (resp.status === 401 || resp.status === 403) return { ok: false, motivo: 'credencial_invalida' }
      if (resp.status >= 500) return { ok: false, motivo: 'indisponivel', detalhe: `HTTP ${resp.status}` }
      const corpo = (await resp.json().catch(() => null)) as Record<string, unknown> | null
      if (!resp.ok || !corpo) {
        const erro = String(corpo?.['error'] ?? corpo?.['message'] ?? '').toLowerCase()
        if (/connect|conect|disconnect|desconect|smartphone/.test(erro)) return { ok: false, motivo: 'canal_desconectado' }
        return { ok: false, motivo: 'resposta_inesperada', detalhe: erro || `HTTP ${resp.status}` }
      }
      const idExterno = String(corpo['messageId'] ?? corpo['zaapId'] ?? corpo['id'] ?? '')
      if (!idExterno) return { ok: false, motivo: 'resposta_inesperada', detalhe: 'envio sem id' }
      return { ok: true, idExterno }
    } catch (erro) {
      if (erro instanceof Error && erro.name === 'AbortError') return { ok: false, motivo: 'indisponivel', detalhe: 'sem resposta no tempo' }
      return { ok: false, motivo: 'indisponivel', detalhe: erro instanceof Error ? erro.message : String(erro) }
    } finally {
      clearTimeout(relogio)
    }
  }

  /** Envia áudio (URL ou data URL base64) — Z-API `send-audio` (vira voz). */
  async enviarAudio(paraE164: string, audio: string): Promise<ResultadoEnvio> {
    const controle = new AbortController()
    const relogio = setTimeout(() => controle.abort(), this.#timeout)
    try {
      const resp = await this.#buscar(this.#url('send-audio'), {
        method: 'POST',
        signal: controle.signal,
        headers: this.#cabecalhos({ 'content-type': 'application/json' }),
        body: JSON.stringify({ phone: paraE164.replace(/^\+/, ''), audio }),
      })
      if (resp.status === 401 || resp.status === 403) return { ok: false, motivo: 'credencial_invalida' }
      if (resp.status >= 500) return { ok: false, motivo: 'indisponivel', detalhe: `HTTP ${resp.status}` }
      const corpo = (await resp.json().catch(() => null)) as Record<string, unknown> | null
      if (!resp.ok || !corpo) {
        const erro = String(corpo?.['error'] ?? corpo?.['message'] ?? '').toLowerCase()
        if (/connect|conect|disconnect|desconect|smartphone/.test(erro)) return { ok: false, motivo: 'canal_desconectado' }
        return { ok: false, motivo: 'resposta_inesperada', detalhe: erro || `HTTP ${resp.status}` }
      }
      const idExterno = String(corpo['messageId'] ?? corpo['zaapId'] ?? corpo['id'] ?? '')
      if (!idExterno) return { ok: false, motivo: 'resposta_inesperada', detalhe: 'envio sem id' }
      return { ok: true, idExterno }
    } catch (erro) {
      if (erro instanceof Error && erro.name === 'AbortError') return { ok: false, motivo: 'indisponivel', detalhe: 'sem resposta no tempo' }
      return { ok: false, motivo: 'indisponivel', detalhe: erro instanceof Error ? erro.message : String(erro) }
    } finally {
      clearTimeout(relogio)
    }
  }

  /** Apaga uma mensagem NOSSA no WhatsApp ("apagar para todos" / recall). */
  async apagarMensagem(paraE164: string, idExterno: string): Promise<ResultadoAcaoMensagem> {
    const controle = new AbortController()
    const relogio = setTimeout(() => controle.abort(), this.#timeout)
    try {
      const phone = paraE164.replace(/^\+/, '')
      // Z-API: DELETE .../messages?messageId=&phone=&owner=true (owner = nossa).
      const url = `${this.#url('messages')}?messageId=${encodeURIComponent(idExterno)}` +
        `&phone=${encodeURIComponent(phone)}&owner=true`
      const resp = await this.#buscar(url, { method: 'DELETE', signal: controle.signal, headers: this.#cabecalhos() })
      if (resp.status === 401 || resp.status === 403) return { ok: false, motivo: 'credencial_invalida' }
      if (resp.status >= 500) return { ok: false, motivo: 'indisponivel', detalhe: `HTTP ${resp.status}` }
      if (!resp.ok) {
        const corpo = (await resp.json().catch(() => null)) as Record<string, unknown> | null
        return { ok: false, motivo: 'resposta_inesperada', detalhe: String(corpo?.['error'] ?? `HTTP ${resp.status}`) }
      }
      return { ok: true }
    } catch (erro) {
      if (erro instanceof Error && erro.name === 'AbortError') return { ok: false, motivo: 'indisponivel', detalhe: 'sem resposta no tempo' }
      return { ok: false, motivo: 'indisponivel', detalhe: erro instanceof Error ? erro.message : String(erro) }
    } finally {
      clearTimeout(relogio)
    }
  }

  /** Edita o texto de uma mensagem NOSSA no WhatsApp. */
  async editarMensagem(paraE164: string, idExterno: string, texto: string): Promise<ResultadoAcaoMensagem> {
    const controle = new AbortController()
    const relogio = setTimeout(() => controle.abort(), this.#timeout)
    try {
      const resp = await this.#buscar(this.#url('edit-message'), {
        method: 'POST',
        signal: controle.signal,
        headers: this.#cabecalhos({ 'content-type': 'application/json' }),
        // ⚠️ Z-API varia o nome do campo entre versões (text × message) —
        //    mandamos os dois; o campo extra é ignorado.
        body: JSON.stringify({ phone: paraE164.replace(/^\+/, ''), messageId: idExterno, text: texto, message: texto }),
      })
      if (resp.status === 401 || resp.status === 403) return { ok: false, motivo: 'credencial_invalida' }
      if (resp.status >= 500) return { ok: false, motivo: 'indisponivel', detalhe: `HTTP ${resp.status}` }
      if (!resp.ok) {
        const corpo = (await resp.json().catch(() => null)) as Record<string, unknown> | null
        return { ok: false, motivo: 'resposta_inesperada', detalhe: String(corpo?.['error'] ?? `HTTP ${resp.status}`) }
      }
      return { ok: true }
    } catch (erro) {
      if (erro instanceof Error && erro.name === 'AbortError') return { ok: false, motivo: 'indisponivel', detalhe: 'sem resposta no tempo' }
      return { ok: false, motivo: 'indisponivel', detalhe: erro instanceof Error ? erro.message : String(erro) }
    } finally {
      clearTimeout(relogio)
    }
  }

  /**
   * Status da instância — está conectada? ⚠️ Antes de enviar em massa, dá para
   * checar; o não-oficial cai quando o celular desliga.
   */
  /**
   * QR de pareamento. ⚠️ Buscado sob demanda: o código expira em segundos.
   */
  async qrCode(): Promise<{ ok: true; imagemDataUrl: string } | { ok: false; motivo: string }> {
    try {
      const resp = await this.#buscar(this.#url('qr-code/image'), { headers: this.#cabecalhos() })
      const corpo = (await resp.json().catch(() => null)) as { value?: string; error?: string } | null
      if (!resp.ok || !corpo?.value) {
        // ⚠️ Instância JÁ conectada não devolve QR — e isso não é erro, é a
        //    resposta certa. Quem chama precisa distinguir para não mostrar
        //    "falhou" a quem está funcionando.
        return { ok: false, motivo: corpo?.error ?? 'qr indisponível — a instância já pode estar conectada' }
      }
      return { ok: true, imagemDataUrl: corpo.value }
    } catch {
      return { ok: false, motivo: 'não foi possível falar com o provedor' }
    }
  }

  /** Contrato da porta — delega ao `status` do fornecedor. */
  async verificarConexao(): Promise<{ conectado: boolean; detalhe?: string | undefined }> {
    return this.status()
  }

  async status(): Promise<{ conectado: boolean; detalhe?: string }> {
    try {
      const resp = await this.#buscar(this.#url('status'), { headers: this.#cabecalhos() })
      const corpo = (await resp.json().catch(() => null)) as Record<string, unknown> | null
      const detalhe = String(corpo?.['error'] ?? '') || undefined
      const conectado = corpo?.['connected'] === true
      return detalhe ? { conectado, detalhe } : { conectado }
    } catch {
      return { conectado: false, detalhe: 'não foi possível consultar' }
    }
  }
}
