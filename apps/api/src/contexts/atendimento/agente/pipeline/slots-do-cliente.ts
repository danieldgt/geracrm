import type { EtapaPreLlm } from './tipos.js'

/**
 * SLOTS DITOS PELO CLIENTE — STUB da raia P3.
 *
 * Contrato a preencher (P3): `extrairSlotsDoCliente` (shared,
 * `agente-perguntas.ts`) sobre os entrantes; slots reconhecidos vão para
 * `estado.perguntas` e viram `instrucoes` ("o cliente já informou o volume").
 * CNPJ vira 'informado' — nunca os dígitos.
 *
 * ⚠️ Enquanto stub: segue sempre.
 */
export const etapaSlotsDoCliente: EtapaPreLlm = {
  nome: 'slots-do-cliente',
  async executar() {
    return { tipo: 'segue' }
  },
}
