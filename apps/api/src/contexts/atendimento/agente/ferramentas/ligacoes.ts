import type { Ligacoes } from './ligacoes-porta.js'
import { conhecimentoDasPoliticas } from './conhecimento-politicas.js'

/**
 * As LIGAÇÕES padrão do agente com os outros contextos.
 *
 * ⚠️ Catálogo e pedido entram aqui quando as raias R2 (catalogo/busca.ts) e R4
 * (pedido/montagem.ts, proposta.ts) forem integradas. Até lá o agente roda com
 * conhecimento + transferência — e o prompt diz ao modelo que não há catálogo
 * neste canal (degradação visível, ADR-008).
 */
export async function ligacoesPadrao(cfg: { tenantId: string; politicas: string }): Promise<Ligacoes> {
  return { conhecimento: conhecimentoDasPoliticas(cfg.politicas) }
}
