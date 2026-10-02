/**
 * A porta de TRANSCRIÇÃO de áudio (IA-03) — definida pelo NOSSO domínio: entra
 * um áudio, sai texto. Qual provedor (Groq/Whisper hoje) é detalhe do adaptador.
 *
 * ⚠️ Assíncrona, em worker — nunca no caminho da requisição (skill geracrm-ia):
 * áudio de 3 minutos não pode segurar a tela nem o 200 do webhook.
 *
 * ⚠️ Falha é retorno TIPIFICADO, nunca exceção: "provedor fora" e "formato não
 * suportado" pedem ações diferentes (tentar de novo × desistir).
 */
export interface AudioParaTranscrever {
  readonly bytes: Buffer
  readonly mime: string
  /** Dica de idioma (BCP-47 curto, ex.: `pt`). O provedor pode ignorar. */
  readonly idioma?: string | undefined
}

export type ResultadoTranscricao =
  | { ok: true; texto: string; idioma?: string | undefined; duracaoS?: number | undefined }
  | { ok: false; motivo: MotivoFalhaTranscricao; detalhe?: string | undefined }

export type MotivoFalhaTranscricao =
  /** Provedor fora do ar / sem chave configurada — a ação é esperar (ou configurar). */
  | 'indisponivel'
  /** O provedor não entende este mime/arquivo — tentar de novo não conserta. */
  | 'formato'
  /** Chave recusada. */
  | 'credencial_invalida'
  /** Acima do teto do provedor (tamanho/duração). */
  | 'muito_longo'

export interface PortaTranscricao {
  readonly nome: string
  /** `transcreve: false` = sem provedor; o worker nem é ligado e a tela avisa. */
  readonly capacidades: { readonly transcreve: boolean }
  transcrever(audio: AudioParaTranscrever): Promise<ResultadoTranscricao>
}

/** Degradação honesta: sem chave, o áudio continua tocável e a transcrição não existe. */
export const TranscricaoIndisponivel: PortaTranscricao = {
  nome: 'indisponivel',
  capacidades: { transcreve: false },
  async transcrever() {
    return { ok: false, motivo: 'indisponivel', detalhe: 'nenhum provedor de transcrição configurado' }
  },
}
