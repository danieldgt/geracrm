/**
 * GATILHOS DE ENTRADA, IDENTIDADE E PRIVACIDADE — STUB da raia P4 (docs/plano-port-playbook-am.md).
 *
 * Contrato a preencher (P4): `detectarOptOut` ("cancelar pedido" NÃO é
 * opt-out), `detectarPedidoHumano`, `detectarReclamacao`,
 * `detectarPerguntaRobo`, `gatilhoExtra`; `textoAbertura`, `textoRobo`,
 * `textoOptOut`.
 *
 * ⚠️ Enquanto stub: nenhum gatilho dispara.
 */
export const GATILHOS_ENTRADA = ['opt_out', 'pedido_humano', 'reclamacao', 'pergunta_robo', 'extra'] as const
export type GatilhoEntrada = (typeof GATILHOS_ENTRADA)[number]

/** Stub: nenhum gatilho reconhecido. */
export function detectarGatilhoDeEntrada(_texto: string): GatilhoEntrada | null {
  return null
}
