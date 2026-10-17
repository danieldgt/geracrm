import {
  descreverSlot, ehSlot, extrairSlotsDoCliente, lerEstadoPerguntas,
  type EstadoPerguntas, type SlotQualificacao, type SlotsDoCliente,
} from '@geracrm/shared'
import type { ContextoPipeline, EtapaPreLlm } from './tipos.js'

/**
 * SLOTS DITOS PELO CLIENTE — raia P3 (playbook AM §3.8, peça 1 e 2).
 *
 * Antes do modelo: o que o cliente trouxe por conta própria (volume, prazo, orçamento, tipo de
 * compra, CNPJ) vira slot respondido EM CÓDIGO, e o modelo é avisado na instrução do turno: "já
 * informado, não pergunte de novo". Se a última pergunta do agente era de um slot que continua
 * sem resposta, a instrução também diz para NÃO repeti-la neste turno.
 *
 * ⚠️ Estado: só devolve patch quando a sessão JÁ existe. Uma etapa pré-LLM que devolve estado
 *    abre sessão `ativa` com 0 turnos se uma etapa seguinte (teto) silenciar — e essa sessão conta
 *    como `sessaoAtiva` no portão seguinte (plano §4). Sem sessão, quem grava é a etapa
 *    `pergunta-repetida`, depois do modelo, no rabo do turno que abre a sessão de qualquer jeito.
 * ⚠️ CNPJ vira 'informado'; orçamento também (valor em R$ na instrução viraria número sem fonte).
 */

/**
 * Slots lidos dos entrantes deste turno (áudio ainda sem transcrição não conta). A pergunta que o
 * agente deixou pendente (`estado.perguntas.ultima.slot`) deixa ler a resposta curta ("50 cx").
 */
export function slotsDosEntrantes(ctx: Pick<ContextoPipeline, 'entrantes' | 'estado'>): SlotsDoCliente {
  const perguntaPendente = lerEstadoPerguntas(ctx.estado['perguntas']).ultima?.slot ?? null
  const r: SlotsDoCliente = {}
  for (const e of ctx.entrantes) {
    if (e.transcricaoPendente || e.transcricaoFalhou) continue
    Object.assign(r, extrairSlotsDoCliente(e.texto, { perguntaPendente }))
  }
  return r
}

export function instrucoesDeSlots(est: EstadoPerguntas, doTurno: SlotsDoCliente): string[] {
  const linhas: string[] = []
  const todos: SlotsDoCliente = { ...est.respondidos, ...doTurno }
  const conhecidos = Object.entries(todos).filter(([k]) => ehSlot(k)) as [SlotQualificacao, string][]
  if (conhecidos.length) {
    linhas.push(`Já informado pelo cliente (considere respondido e não pergunte de novo): ${conhecidos.map(([k, v]) => descreverSlot(k, v)).join('; ')}.`)
  }
  const u = est.ultima
  if (u?.slot && !todos[u.slot]) {
    linhas.push(`Sua última pergunta foi: "${u.texto}". Se o cliente não respondeu a ela, NÃO a repita neste turno — responda ao que ele trouxe e, se precisar perguntar, pergunte outra coisa.`)
  }
  return linhas
}

export const etapaSlotsDoCliente: EtapaPreLlm = {
  nome: 'slots-do-cliente',
  async executar(ctx) {
    const est = lerEstadoPerguntas(ctx.estado['perguntas'])
    const doTurno = slotsDosEntrantes(ctx)
    const instrucoes = instrucoesDeSlots(est, doTurno)
    const novos = Object.entries(doTurno).some(([k, v]) => est.respondidos[k as SlotQualificacao] !== v)
    const estado = ctx.sessaoId && novos
      ? { perguntas: { ...est, respondidos: { ...est.respondidos, ...doTurno } } }
      : undefined
    return { tipo: 'segue', ...(instrucoes.length ? { instrucoes } : {}), ...(estado ? { estado } : {}) }
  },
}
