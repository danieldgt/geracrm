import type { EtapaPosResposta } from './tipos.js'

/**
 * REGRAS DE QUALIDADE ANTES DO ENVIO — STUB da raia P12 (ADR-031).
 *
 * Contrato a preencher (P12): regras determinísticas em 100% dos turnos; uma
 * violação CRÍTICA → `bloquear` com `qualidade_violacao_critica` (autônomo não
 * envia e entrega ao humano; assistido vira sugestão "não envie") + alerta. A
 * amostragem do juiz roda fora do turno (`workers/qualidade.ts`).
 *
 * ⚠️ Enquanto stub: devolve as mensagens intactas, sem marcas.
 */
export const etapaRegrasQualidade: EtapaPosResposta = {
  nome: 'regras-qualidade',
  async executar(_ctx, entrada) {
    return { mensagens: entrada.mensagens, guardrails: [] }
  },
}
