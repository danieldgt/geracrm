/**
 * BATIMENTO DOS WORKERS (raia P8 — saúde em três estados).
 *
 * Cada intervalo de `server.ts` chama `batimento(nome)` ao fim de cada passada
 * (no `finally`: passada com erro também conta — o worker está vivo; o erro vai
 * para o log). A saúde detalhada (`GET /saude/detalhada`) lê `idadeDoBatimentoSeg`
 * e diz "worker do agente sem passada há 5 min" em vez de só "processo vivo".
 *
 * ⚠️ Estado EM MEMÓRIA do processo, de propósito: é a pergunta "ESTA instância
 *    está trabalhando?". Não é dado de negócio e não tem tenant. Com várias
 *    instâncias, cada uma responde por si — o monitor olha a que o balanceador
 *    entregar, e um worker parado em qualquer uma aparece cedo ou tarde.
 * ⚠️ Passada longa (turno de IA, rede do embedding) atrasa o batimento pelo
 *    tempo da passada: os limiares em `LIMITES_SAUDE_PADRAO` já contam com isso.
 */
export const BATIMENTOS = [
  'webhookSaida', 'automacao', 'sincronizacaoMidia', 'conversoesMidia', 'vigiaMidia', 'vigiaCanal', 'resumoMidia',
  'campanha', 'workerAgente', 'transcricao', 'retornos', 'push', 'embeddings', 'qualidade', 'sla', 'posIngestao',
] as const
export type NomeBatimento = (typeof BATIMENTOS)[number]

const ultimos = new Map<NomeBatimento, Date>()

/** Registra que o worker `nome` deu uma passada agora. Barato: nunca faz I/O. */
export function batimento(nome: NomeBatimento, agora: Date = new Date()): void {
  ultimos.set(nome, agora)
}

/** Último batimento de cada worker que já bateu nesta instância. */
export function batimentos(): ReadonlyMap<NomeBatimento, Date> {
  return ultimos
}

/** Segundos desde a última passada de `nome` (inteiro, nunca negativo); null = ainda não bateu. */
export function idadeDoBatimentoSeg(
  nome: NomeBatimento, agora: Date = new Date(), fonte: ReadonlyMap<NomeBatimento, Date> = ultimos,
): number | null {
  const ultimo = fonte.get(nome)
  if (!ultimo) return null
  return Math.max(0, Math.floor((agora.getTime() - ultimo.getTime()) / 1000))
}
