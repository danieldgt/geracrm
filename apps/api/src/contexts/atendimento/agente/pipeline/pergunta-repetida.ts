import type { EtapaPosResposta } from './tipos.js'

/**
 * TRAVA DE PERGUNTA REPETIDA — STUB da raia P3.
 *
 * Contrato a preencher (P3): `evitarPerguntaRepetida` (shared,
 * `agente-perguntas.ts`) contra `falasAnterioresDoAgente` e
 * `estado.perguntas.ultima` (sobrevive a restart); pergunta repetida
 * (Jaccard ≥ 0,7) é trocada pela do próximo slot aberto ou por uma neutra —
 * marca MEDIA `pergunta_repetida` 'substituido'.
 *
 * ⚠️ Enquanto stub: devolve as mensagens intactas, sem marcas.
 */
export const etapaPerguntaRepetida: EtapaPosResposta = {
  nome: 'pergunta-repetida',
  async executar(_ctx, entrada) {
    return { mensagens: entrada.mensagens, guardrails: [] }
  },
}
