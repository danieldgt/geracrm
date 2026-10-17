import { custoEstimadoCentavos, type UsoDoLaco } from './porta-llm.js'

/**
 * CUSTO DE UM LAÇO — STUB da raia P6 (ADR-032).
 *
 * Contrato a preencher (P6): `normalizarIdModelo`; `precoDoModelo` pelo
 * catálogo `modelo_ia` (cache 10 min), gratuito custa 0, desconhecido = maior
 * preço + alerta `preco_desconhecido`; teto por sessão e alerta mensal.
 *
 * ⚠️ Assíncrono de propósito: o preço virá do banco (com cache). O turno
 *    sempre chama por aqui — nunca `custoEstimadoCentavos` direto.
 * ⚠️ Enquanto stub: a tabela fixa de `porta-llm.ts`, como antes (modelo
 *    desconhecido cai no preço do Opus).
 */
export async function custoDoLaco(p: { provedor: string | null; modelo: string; uso: UsoDoLaco }): Promise<number> {
  return custoEstimadoCentavos(p.modelo, p.uso)
}
