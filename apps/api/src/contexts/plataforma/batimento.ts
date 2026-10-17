/**
 * BATIMENTO DOS WORKERS — STUB da raia P8 (saúde em três estados).
 *
 * Cada intervalo de `server.ts` chama `batimento(nome)` a cada passada; a
 * saúde detalhada (P8, `GET /saude/detalhada`) lê `batimentos()` e diz
 * "worker do agente parado há 5 min" em vez de só "processo vivo".
 *
 * Contrato a preencher (P8): limiares por componente, `avaliarSaude` pura em
 * `@geracrm/shared` (`agente-saude.ts`), componentes {processo, banco,
 * workerAgente, filaAgente, llm, transcricao, embeddings, retornos}.
 *
 * ⚠️ Estado EM MEMÓRIA do processo, de propósito: é a pergunta "ESTA instância
 *    está trabalhando?". Não é dado de negócio e não tem tenant.
 * ⚠️ Enquanto stub: só registra o instante; ninguém lê ainda.
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
