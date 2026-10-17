import type { EtapaPreLlm } from './tipos.js'

/**
 * GATILHOS DE ENTRADA — STUB da raia P4.
 *
 * Contrato a preencher (P4), sem modelo e antes dele: opt-out ("pare") envia a
 * confirmação, registra, cancela retornos e encerra a sessão (`handoff` ou
 * `resposta_fixa`); pedido de humano e Procon/reclamação → `handoff`;
 * "é robô?" → 1ª `resposta_fixa`, 2ª `handoff pergunta_robo` (contagem em
 * `estado.gatilhos`); áudio com transcrição pendente → `silencio`; falha de
 * transcrição → 1ª pede texto, 2ª `handoff audio_sem_transcricao`; abertura
 * fixa na primeira resposta em autônomo. Regras puras em
 * `@geracrm/shared` (`agente-gatilhos.ts`).
 *
 * ⚠️ Enquanto stub: segue sempre.
 */
export const etapaGatilhosEntrada: EtapaPreLlm = {
  nome: 'gatilhos-entrada',
  async executar() {
    return { tipo: 'segue' }
  },
}
