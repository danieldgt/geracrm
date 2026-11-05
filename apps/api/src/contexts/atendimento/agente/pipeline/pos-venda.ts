import { CHAVE_POS_VENDA, instrucoesDoPosVenda, lerPosVenda } from '../pos-venda.js'
import type { EtapaPreLlm } from './tipos.js'

/**
 * PÓS-VENDA — leitor dos roteiros abertos pela ativa de pós-venda (raia G3).
 *
 * Quando a pesquisa NPS ou o pedido de indicação SAIU para o cliente, a sessão
 * guarda `estado_agente.posVenda.<roteiro>` (`../pos-venda.ts`). Esta etapa,
 * pré-modelo e depois da devolução da equipe, põe uma instrução curta no turno
 * dizendo o que foi perguntado e qual ferramenta registra a resposta.
 *
 * ⚠️ Só ACRESCENTA instrução (ADR-029): não pula, não reordena e não desliga etapa.
 *    Não consome a chave — o roteiro vale pelo prazo; quem fecha é a própria
 *    ferramenta (NPS: `npsRegistradoEm`; indicação: o teto `registradas`). A
 *    instrução não carrega número de negócio além do teto restante.
 */

export const ETAPA_POS_VENDA = 'pos-venda'

export const etapaPosVenda: EtapaPreLlm = {
  nome: ETAPA_POS_VENDA,
  async executar(ctx) {
    if (!ctx.sessaoId) return { tipo: 'segue' }
    const instrucoes = instrucoesDoPosVenda(lerPosVenda(ctx.estado[CHAVE_POS_VENDA]), ctx.agora)
    return instrucoes.length > 0 ? { tipo: 'segue', instrucoes } : { tipo: 'segue' }
  },
}
