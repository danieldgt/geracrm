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

/** Até quando a última pergunta do agente ainda é "a pergunta que o cliente está respondendo". */
export const VALIDADE_PERGUNTA_PENDENTE_MS = 24 * 60 * 60 * 1000

/**
 * A pergunta pendente que ainda vale: só em AUTÔNOMO (nos outros modos o cliente não viu a
 * pergunta do agente — `ultima` nem é gravada lá, mas o modo pode ter mudado desde então) e só se
 * feita há no máximo 24 h (depois disso a mensagem nova não é resposta a ela). Fora disso, a
 * extração exige intenção explícita.
 */
export function perguntaPendenteValida(ctx: Pick<ContextoPipeline, 'estado' | 'modo' | 'agora'>): SlotQualificacao | null {
  if (ctx.modo !== 'autonomo') return null
  const u = lerEstadoPerguntas(ctx.estado['perguntas']).ultima
  const em = u ? Date.parse(u.em) : NaN
  if (!u?.slot || !Number.isFinite(em)) return null
  const idade = ctx.agora.getTime() - em
  return idade >= 0 && idade <= VALIDADE_PERGUNTA_PENDENTE_MS ? u.slot : null
}

/**
 * Slots lidos dos entrantes deste turno (áudio ainda sem transcrição não conta). A pergunta
 * pendente válida deixa ler a resposta sem verbo de intenção ("então, 80 caixas mesmo").
 */
export function slotsDosEntrantes(ctx: Pick<ContextoPipeline, 'entrantes' | 'estado' | 'modo' | 'agora'>): SlotsDoCliente {
  const perguntaPendente = perguntaPendenteValida(ctx)
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
