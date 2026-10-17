import type { EtapaPosResposta } from './tipos.js'

/**
 * GUARDRAIL NUMÉRICO AMPLIADO — STUB da raia P7.
 *
 * Contrato a preencher (P7): `extrairNumerosDeNegocio` (shared,
 * `agente-numeros.ts`) contra `numerosVistos` (ferramentas, políticas,
 * conhecimento, cliente). "%" sem fonte → `bloquear`; "temos N" / "entrega em
 * N dias" sem fonte → `bloquear`; os demais → marca ALTA. Roda logo depois do
 * guardrail de R$ (que segue em `vendedor.ts`).
 *
 * ⚠️ Enquanto stub: devolve as mensagens intactas, sem marcas.
 */
export const etapaNumerosAmpliados: EtapaPosResposta = {
  nome: 'numeros-ampliados',
  async executar(_ctx, entrada) {
    return { mensagens: entrada.mensagens, guardrails: [] }
  },
}
