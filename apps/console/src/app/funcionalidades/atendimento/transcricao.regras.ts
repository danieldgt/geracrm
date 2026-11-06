/**
 * O que mostrar embaixo de um áudio no chat (IA-03): a transcrição fica ABAIXO do
 * player, nunca no lugar dele — a vendedora pode sempre ouvir o original.
 */
export type VistaTranscricao =
  | { readonly tipo: 'texto'; readonly texto: string }
  | { readonly tipo: 'transcrevendo' }
  | { readonly tipo: 'falhou' }
  | null

/** O worker tenta 3 vezes, de 2 em 2 minutos: passado isso, não há mais o que esperar. */
export const ESPERA_TRANSCRICAO_MS = 10 * 60_000
const MAX_TENTATIVAS = 3

interface MensagemDeAudio {
  readonly tipo: string
  readonly direcao: 'entrante' | 'saliente'
  readonly conteudo: unknown
  readonly criadoEm: string
}

/**
 * ⚠️ "Transcrevendo…" só nos primeiros minutos: sem provedor de transcrição o worker
 * nem roda, e um aviso eterno de "transcrevendo" mentiria. Depois da janela, sem
 * texto e sem erro registrado, o áudio aparece sozinho, como antes.
 */
export function vistaTranscricao(m: MensagemDeAudio, agoraMs: number): VistaTranscricao {
  if (m.tipo !== 'audio' || m.direcao !== 'entrante') return null
  const c = (m.conteudo ?? {}) as Record<string, unknown>
  const texto = c['transcricao']
  if (typeof texto === 'string') return texto.trim() ? { tipo: 'texto', texto: texto.trim() } : { tipo: 'falhou' }
  if (Number(c['transcricao_tentativas'] ?? 0) >= MAX_TENTATIVAS) return { tipo: 'falhou' }
  const idade = agoraMs - Date.parse(m.criadoEm)
  return Number.isFinite(idade) && idade < ESPERA_TRANSCRICAO_MS ? { tipo: 'transcrevendo' } : null
}
