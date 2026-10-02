import { TranscricaoGroqWhisper } from './groq-whisper.js'
import { TranscricaoIndisponivel, type PortaTranscricao } from './porta.js'

/**
 * Escolhe o provedor de transcrição pelo ambiente:
 *   GROQ_API_KEY            → Groq (Whisper), modelo em TRANSCRICAO_MODELO
 *   TRANSCRICAO_URL         → outra API compatível com OpenAI (opcional)
 *   nada                    → `TranscricaoIndisponivel` (capacidade false)
 *
 * ⚠️ Sem chave o produto DEGRADA e avisa uma vez no log: o worker não é ligado,
 * o áudio continua tocável, a transcrição simplesmente não existe.
 */
export function transcricaoDoAmbiente(env: NodeJS.ProcessEnv = process.env): PortaTranscricao {
  const apiKey = env.GROQ_API_KEY?.trim()
  if (!apiKey) return TranscricaoIndisponivel
  return new TranscricaoGroqWhisper({
    apiKey,
    modelo: env.TRANSCRICAO_MODELO?.trim() || undefined,
    url: env.TRANSCRICAO_URL?.trim() || undefined,
  })
}
