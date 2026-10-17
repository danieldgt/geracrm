import type { EtapaModoEfetivo } from './tipos.js'

/**
 * MODO EFETIVO — STUB da raia P14 (ADR-028: "o mais restritivo vence").
 *
 * Contrato a preencher (P14): `decidirModoEfetivo` = o mais restritivo entre o
 * teto do tenant (`agente_tenant.modo_maximo`), o modo do número e o recorte
 * (`agente_config.recorte` em `cfgExtra`: horário, segmentos RFV,
 * foraDoRecorte). Roda ANTES do portão: um número em autônomo fora do recorte
 * entra no portão como sombra (ou desligado).
 *
 * ⚠️ Enquanto stub: o modo do número, sem mudança.
 */
export const etapaModoEfetivo: EtapaModoEfetivo = {
  nome: 'modo-efetivo',
  async decidir(entrada) {
    return { modo: entrada.modoDoNumero, motivo: null }
  },
}
