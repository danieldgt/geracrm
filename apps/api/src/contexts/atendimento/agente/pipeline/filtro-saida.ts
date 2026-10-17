import type { EtapaPosResposta } from './tipos.js'

/**
 * FILTRO DE SAÍDA COM NEGAÇÃO — STUB da raia P2.
 *
 * Contrato a preencher (P2): `filtrarSaida` (shared, `agente-filtro.ts`) com
 * `PROIBIDAS_BASE_B2B` + extras do canal (`agente_config.compliance` em
 * `cfgExtra`, só acrescentam). Frase proibida removida → marca CRITICA
 * 'removido'; hesitação reescrita → 'reescrito'. Vale em autônomo, assistido,
 * sombra e simulação. Com `handoff`, aplica `ajustarMensagemHandoff`.
 *
 * ⚠️ Enquanto stub: devolve as mensagens intactas, sem marcas.
 */
export const etapaFiltroSaida: EtapaPosResposta = {
  nome: 'filtro-saida',
  async executar(_ctx, entrada) {
    return { mensagens: entrada.mensagens, guardrails: [] }
  },
}
