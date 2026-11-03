import { CHAVE_POS_VENDA, instrucaoDoRoteiro, lerRoteiroPosVenda, roteiroVigente } from '../pos-venda.js'
import type { EtapaPreLlm } from './tipos.js'

/**
 * PÓS-VENDA — leitor do roteiro aberto pela ativa de pós-venda (raia G3).
 *
 * Quando a pesquisa NPS ou o pedido de indicação SAIU para o cliente, a sessão
 * guarda `estado_agente.posVenda` (`../pos-venda.ts`). Esta etapa, pré-modelo e
 * depois da devolução da equipe, põe uma instrução curta no turno dizendo o que
 * foi perguntado e qual ferramenta registra a resposta.
 *
 * ⚠️ Só ACRESCENTA instrução (ADR-029): não pula, não reordena e não desliga etapa.
 *    Não consome a chave — o roteiro vale pelo prazo; quem fecha o NPS é a própria
 *    ferramenta `registrar_nps` (carimbo `npsRegistradoEm`). A instrução não carrega
 *    número de negócio: a nota é do cliente e só vira registro pela ferramenta.
 */

export const ETAPA_POS_VENDA = 'pos-venda'

export const etapaPosVenda: EtapaPreLlm = {
  nome: ETAPA_POS_VENDA,
  async executar(ctx) {
    const r = lerRoteiroPosVenda(ctx.estado[CHAVE_POS_VENDA])
    if (!ctx.sessaoId || !roteiroVigente(r, ctx.agora)) return { tipo: 'segue' }
    const instrucao = instrucaoDoRoteiro(r)
    return instrucao ? { tipo: 'segue', instrucoes: [instrucao] } : { tipo: 'segue' }
  },
}
