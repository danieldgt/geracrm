/**
 * Em que pé está a transcrição de uma mensagem — a regra que o turno do agente usa
 * para decidir entre esperar, responder ao texto ou pedir que o cliente escreva.
 */
export type EstadoTranscricao = 'nao_se_aplica' | 'pronta' | 'pendente' | 'falhou'

/**
 * ⚠️ Sem provedor (`transcreve = false`) o áudio é FALHA, não pendência: o worker nem
 * é ligado, então nada vai chegar. Tratar como pendente deixava o agente em silêncio
 * para sempre — sem pedir texto e sem passar para uma pessoa.
 */
export function estadoDaTranscricao(
  tipo: string, conteudo: Record<string, unknown>, transcreve: boolean, maxTentativas: number,
): EstadoTranscricao {
  if (tipo !== 'audio') return 'nao_se_aplica'
  const texto = conteudo['transcricao']
  // Transcrito, mas vazio (áudio mudo, só ruído): o worker não tenta de novo — é falha.
  if (typeof texto === 'string') return texto.trim() !== '' ? 'pronta' : 'falhou'
  if (!transcreve) return 'falhou'
  return Number(conteudo['transcricao_tentativas'] ?? 0) >= maxTentativas ? 'falhou' : 'pendente'
}
