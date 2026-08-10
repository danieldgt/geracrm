/**
 * A porta de CANAL — o que um canal de mensagem faz, definido pelo NOSSO
 * domínio, nunca pela API do fornecedor (mesma filosofia dos conectores de ERP,
 * ADR-008/021).
 *
 * ⚠️ Oficial (Meta) e não-oficial (PlugZapi) são dois ADAPTADORES desta porta.
 * O resto do produto (Inbox, campanha, pedido) fala com a porta e não sabe por
 * qual caminho a mensagem foi — só o adaptador conhece o formato do fornecedor.
 *
 * Vive no contexto `atendimento` da API (server-side): sai para a rede e não é
 * consumido por Angular/Expo, então não precisa da pureza de `packages/shared`.
 */

/**
 * Capacidades declaradas do canal. O produto DEGRADA conforme isto (ADR-008):
 * o não-oficial não tem janela de 24h nem template — envia texto livre, com o
 * alerta de risco visível.
 */
export interface CapacidadesCanal {
  /** Janela de 24h + reabertura por template (só o oficial). */
  readonly janela24h: boolean
  readonly aceitaTemplate: boolean
  /** ⚠️ Automatiza um WhatsApp Web — pode levar a banimento (não-oficial). */
  readonly riscoBanimento: boolean
  /** Envia texto livre a qualquer momento (não-oficial, sem janela). */
  readonly textoLivreSempre: boolean
}

/**
 * Resultado de um envio — retorno TIPIFICADO, nunca exceção (falha de negócio é
 * resultado esperado). "Número desconectado" e "instância caiu" pedem ações
 * diferentes de quem opera.
 */
export type ResultadoEnvio =
  | { ok: true; idExterno: string }
  | { ok: false; motivo: MotivoFalhaEnvio; detalhe?: string | undefined }

export type MotivoFalhaEnvio =
  /** A instância/número não está conectada (não-oficial: celular desligado). */
  | 'canal_desconectado'
  /** Credencial (token/client-token) recusada. */
  | 'credencial_invalida'
  /** O destino não é um WhatsApp válido. */
  | 'destino_invalido'
  /** Fornecedor fora do ar — a ação é esperar. */
  | 'indisponivel'
  /** Resposta inesperada do fornecedor. */
  | 'resposta_inesperada'

/**
 * Uma mensagem ENTRANTE, já traduzida do formato do fornecedor para o nosso.
 *
 * ⚠️ O adaptador do canal (PlugZapi, Meta) traduz o webhook cru para isto. O
 * resto do produto (ingestão, Inbox) só conhece esta forma — nunca o `text`
 * aninhado do Z-API nem o `messages[]` da Meta.
 */
export interface MensagemEntrante {
  /** Telefone do remetente, E.164 sem `+`. */
  readonly deE164: string
  /** Id externo da mensagem — dedup (INV-38). */
  readonly idExterno: string
  readonly tipo: 'texto' | 'imagem' | 'audio'
  /** Texto (tipo texto) ou legenda (mídia). */
  readonly texto?: string | undefined
  /** URL da mídia (imagem/áudio) fornecida pelo provedor. */
  readonly midiaUrl?: string | undefined
  readonly mime?: string | undefined
  readonly nomeRemetente?: string | undefined
  readonly recebidaEm: Date
}

/**
 * O que o webhook contém. ⚠️ Nem todo callback é mensagem entrante: status de
 * entrega, mensagem NOSSA (fromMe), evento de grupo. Só `mensagem_entrante` vira
 * conversa; o resto é ignorado (mas com 200, senão o fornecedor reenvia — regra
 * do webhook: código HTTP é instrução).
 */
export type EventoWebhook =
  | { tipo: 'mensagem_entrante'; mensagem: MensagemEntrante }
  // ⚠️ Status de entrega de uma mensagem NOSSA (saliente): os dois tiques.
  //    `idExterno` casa com o id que o envio guardou; `status` já normalizado.
  | { tipo: 'status_mensagem'; idExterno: string; status: 'enviada' | 'entregue' | 'lida' }
  | { tipo: 'ignorado'; motivo: string }

export interface PortaCanal {
  readonly tipo: 'whatsapp_oficial' | 'whatsapp_nao_oficial'
  readonly capacidades: CapacidadesCanal

  /**
   * Envia texto para um destino (E.164 sem `+`, como o WhatsApp usa).
   * ⚠️ O gateway de saída revalida janela/opt-out/bloqueio ANTES de chamar isto
   * — o adaptador só entrega ao fornecedor.
   */
  enviarTexto(paraE164: string, texto: string): Promise<ResultadoEnvio>

  /** Envia uma imagem (URL ou data URL base64) com legenda opcional. */
  enviarImagem(paraE164: string, imagem: string, legenda?: string): Promise<ResultadoEnvio>

  /** Envia um áudio (URL ou data URL base64) — vira mensagem de voz. */
  enviarAudio(paraE164: string, audio: string): Promise<ResultadoEnvio>

  /** Apaga uma mensagem NOSSA no WhatsApp ("apagar para todos" / recall). */
  apagarMensagem(paraE164: string, idExterno: string): Promise<ResultadoAcaoMensagem>

  /** Edita o texto de uma mensagem NOSSA no WhatsApp (janela do fornecedor). */
  editarMensagem(paraE164: string, idExterno: string, texto: string): Promise<ResultadoAcaoMensagem>
}

export type ResultadoAcaoMensagem =
  | { ok: true }
  | { ok: false; motivo: MotivoFalhaEnvio; detalhe?: string }
