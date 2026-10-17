/**
 * FILTRO DE SAÍDA COM NEGAÇÃO — STUB da raia P2 (docs/plano-port-playbook-am.md).
 *
 * Contrato a preencher (P2): `termoNegado(frase, inicio)` com a regra da AM
 * (mesma oração, ≤2 palavras, conectivos, "sem" colado, dupla negação =
 * afirmação); `filtrarSaida(texto, {extras?, limites?})`;
 * `ajustarMensagemHandoff(texto, {semNumeros})`; `PROIBIDAS_BASE_B2B`;
 * `ComplianceExtra {frasesProibidas ≤50×80, gatilhosHandoff ≤50}`.
 *
 * ⚠️ Enquanto stub, devolve o texto INTACTO — nenhum comportamento muda.
 * TypeScript puro: consumido pela API e pelo console.
 */
import type { GravidadeGuardrail } from './agente-vendedor.js'

export interface OcorrenciaFiltro {
  readonly id: string
  readonly gravidade: GravidadeGuardrail
  readonly acao: 'removido' | 'reescrito'
}

export interface ResultadoFiltroSaida {
  readonly texto: string
  readonly alterado: boolean
  readonly ocorrencias: readonly OcorrenciaFiltro[]
}

export interface OpcoesFiltroSaida {
  readonly extras?: readonly string[] | undefined
  readonly limites?: { readonly maxCaracteres: number; readonly maxPerguntas: number } | undefined
}

/** Stub: identidade. */
export function filtrarSaida(texto: string, _opcoes: OpcoesFiltroSaida = {}): ResultadoFiltroSaida {
  return { texto, alterado: false, ocorrencias: [] }
}
