import type { EtapaTetoConversa } from './tipos.js'

/**
 * TETO DE CUSTO POR CONVERSA — STUB da raia P6 (ADR-032).
 *
 * Contrato a preencher (P6): teto por sessão (`agente_config.teto_sessao_centavos`
 * em `cfgExtra`, padrão `IA_TETO_SESSAO_CENTAVOS`).
 *   antes  — sessão acima do teto: autônomo → `handoff limite_de_custo_conversa`
 *            com aviso; sombra/assistido → `silencio`.
 *   depois — este turno estourou: responde (já respondeu) e transfere em
 *            silêncio (`handoff` sem aviso).
 * O teto DIÁRIO por número continua no portão de `vendedor.ts`.
 *
 * ⚠️ Enquanto stub: segue sempre, antes e depois.
 */
export const etapaTetoConversa: EtapaTetoConversa = {
  nome: 'teto-conversa',
  async antes() {
    return { tipo: 'segue' }
  },
  async depois() {
    return { tipo: 'segue' }
  },
}
