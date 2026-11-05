import {
  DIAS_DEPOIS_MAX, ROTULO_ROTEIRO_POS_VENDA, ROTEIROS_POS_VENDA, validarAcaoAgenteEnvia, validarGatilhoPedidoEfetivado,
  type RoteiroPosVenda,
} from '@geracrm/shared'

/**
 * Regras PURAS do formulário de Automações para o PÓS-VENDA (G3) — sem Angular.
 *
 * O gatilho "Pedido efetivado" e a ação "Agente envia mensagem (pós-venda)" andam
 * JUNTOS (a API recusa um sem o outro: `automacao.pos_venda_combinacao`): a tela
 * troca o par sozinha em vez de deixar montar uma regra que vai voltar 422.
 * A validação usa as MESMAS funções da API (`@geracrm/shared`).
 */

export const GATILHO_POS_VENDA = 'pedido_efetivado'
export const ACAO_POS_VENDA = 'agente_envia'
export { DIAS_DEPOIS_MAX, ROTEIROS_POS_VENDA, ROTULO_ROTEIRO_POS_VENDA }

/** Ao escolher o gatilho: pedido efetivado puxa a ação do agente; sair dele devolve a ação padrão. */
export function acaoAoTrocarGatilho(gatilho: string, acaoAtual: string): string {
  if (gatilho === GATILHO_POS_VENDA) return ACAO_POS_VENDA
  return acaoAtual === ACAO_POS_VENDA ? 'criar_tarefa' : acaoAtual
}

/** Ao escolher a ação: a do agente puxa o gatilho de pedido; sair dela devolve o gatilho padrão. */
export function gatilhoAoTrocarAcao(acao: string, gatilhoAtual: string): string {
  if (acao === ACAO_POS_VENDA) return GATILHO_POS_VENDA
  return gatilhoAtual === GATILHO_POS_VENDA ? 'dias_sem_comprar' : gatilhoAtual
}

export interface FormPosVenda {
  readonly diasDepois: number
  readonly roteiro: RoteiroPosVenda
  readonly texto: string
  /** '' = sem template. */
  readonly templateId: string
}

export interface ParamsPosVenda {
  readonly gatilhoParam: { readonly diasDepois: number }
  readonly acaoParam: { readonly roteiro: RoteiroPosVenda; readonly texto: string | null; readonly templateId: string | null }
}

/** Valida e monta os parâmetros; erro = a frase que vai ao lado do botão (a API repete a regra). */
export function paramsPosVenda(f: FormPosVenda): { ok: true; params: ParamsPosVenda } | { ok: false; erro: string } {
  const g = validarGatilhoPedidoEfetivado({ diasDepois: f.diasDepois })
  if (!g.ok) return { ok: false, erro: g.mensagem }
  const a = validarAcaoAgenteEnvia({ roteiro: f.roteiro, texto: f.texto, templateId: f.templateId || null })
  if (!a.ok) return { ok: false, erro: a.mensagem }
  return { ok: true, params: { gatilhoParam: g.dados, acaoParam: a.dados } }
}

/** "no dia da efetivação" · "1 dia depois da efetivação" · "7 dias depois…". */
export function textoDiasDepois(dias: number): string {
  if (dias <= 0) return 'no dia da efetivação'
  return `${dias} ${dias === 1 ? 'dia' : 'dias'} depois da efetivação`
}

/** A linha da regra na lista: "Quando pedido efetivado (3 dias depois…) → agente envia: Pesquisa NPS". */
export function descreverPosVenda(gatilhoParam: Record<string, unknown>, acaoParam: Record<string, unknown>): string {
  const dias = Number(gatilhoParam['diasDepois'] ?? 0)
  const r = acaoParam['roteiro']
  const roteiro = (ROTEIROS_POS_VENDA as readonly string[]).includes(String(r)) ? ROTULO_ROTEIRO_POS_VENDA[r as RoteiroPosVenda] : 'mensagem'
  return `Quando um pedido é efetivado (${textoDiasDepois(Number.isFinite(dias) ? dias : 0)}) → o agente envia: ${roteiro}`
}

/** Aviso do não-oficial: só com template a regra não fala nada lá (template é do oficial). */
export function avisoSoTemplate(f: Pick<FormPosVenda, 'texto' | 'templateId'>): string | null {
  return !f.texto.trim() && f.templateId
    ? 'Sem texto, só números do WhatsApp oficial enviam (pelo template). No não-oficial a mensagem não sai.'
    : null
}
