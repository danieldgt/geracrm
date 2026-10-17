import type { MarcaGuardrail } from '@geracrm/shared'
import { juntarPatches } from '../estado-agente.js'
import { etapaModoEfetivo } from './modo-efetivo.js'
import { etapaGatilhosEntrada } from './gatilhos-entrada.js'
import { etapaSlotsDoCliente } from './slots-do-cliente.js'
import { etapaTetoConversa } from './teto-conversa.js'
import { etapaNumerosAmpliados } from './numeros-ampliados.js'
import { etapaFiltroSaida } from './filtro-saida.js'
import { etapaPerguntaRepetida } from './pergunta-repetida.js'
import { etapaRegrasQualidade } from './regras-qualidade.js'
import { politicaFalhaLlm } from './falha-llm.js'
import type {
  ContextoPipeline, DecisaoPreLlm, EfeitoPosEnvio, EntradaPosResposta, EtapaPosResposta, EtapaPreLlm, PatchEstado, PipelineDoTurno,
  ResultadoPosResposta,
} from './tipos.js'

export * from './tipos.js'

/**
 * O PIPELINE DO TURNO, MONTADO — a ordem é esta e só muda aqui (raia P0).
 *
 *   modoEfetivo → [portão] → gatilhos → slots → teto(pré) → LLM →
 *   [guardrail R$] → números → filtro → pergunta → qualidade → envio → teto(pós)
 *
 * Cada etapa mora no seu arquivo e tem uma raia dona; editar a etapa NÃO exige
 * tocar aqui nem em `vendedor.ts`. Testes trocam etapas por falsas com
 * `montarPipeline({ filtro: etapaFalsa })`.
 */
export const PIPELINE_PADRAO: PipelineDoTurno = {
  modoEfetivo: etapaModoEfetivo,
  gatilhos: etapaGatilhosEntrada,
  slots: etapaSlotsDoCliente,
  teto: etapaTetoConversa,
  numeros: etapaNumerosAmpliados,
  filtro: etapaFiltroSaida,
  pergunta: etapaPerguntaRepetida,
  qualidade: etapaRegrasQualidade,
  falha: politicaFalhaLlm,
}

export function montarPipeline(sobrepor: Partial<PipelineDoTurno> = {}): PipelineDoTurno {
  return { ...PIPELINE_PADRAO, ...sobrepor }
}

/** Etapas antes do modelo, na ordem. O teto entra pelo seu lado `antes`. */
function etapasPreLlm(p: PipelineDoTurno): readonly EtapaPreLlm[] {
  return [p.gatilhos, p.slots, { nome: p.teto.nome, executar: (ctx) => p.teto.antes(ctx) }]
}

/** Etapas depois do modelo (e do guardrail de R$), na ordem. */
function etapasPosResposta(p: PipelineDoTurno): readonly EtapaPosResposta[] {
  return [p.numeros, p.filtro, p.pergunta, p.qualidade]
}

export interface ResultadoPreLlm {
  /** A primeira decisão que não foi `segue` — ou `segue`, se todas seguiram. */
  readonly decisao: Exclude<DecisaoPreLlm, { tipo: 'segue' }> | { readonly tipo: 'segue' }
  /** Instruções acumuladas das etapas que seguiram (vão para o operador). */
  readonly instrucoes: readonly string[]
  /** Patch de estado acumulado (inclui o da decisão final, se houver). */
  readonly estado: PatchEstado
  readonly guardrails: readonly MarcaGuardrail[]
  /** Prefixos das etapas que seguiram, na ordem (o rabo envia antes da resposta). */
  readonly prefixo: readonly string[]
  /** Efeitos pós-envio das etapas que seguiram + o da decisão final. */
  readonly efeitos: readonly EfeitoPosEnvio[]
}

/**
 * Roda gatilhos → slots → teto(pré). Para na primeira decisão que não é
 * `segue`. Cada etapa enxerga o estado já com os patches das anteriores.
 */
export async function rodarPreLlm(p: PipelineDoTurno, ctx: ContextoPipeline): Promise<ResultadoPreLlm> {
  const instrucoes: string[] = []
  const patches: PatchEstado[] = []
  const guardrails: MarcaGuardrail[] = []
  const prefixo: string[] = []
  const efeitos: EfeitoPosEnvio[] = []
  let atual = ctx
  for (const etapa of etapasPreLlm(p)) {
    const d = await etapa.executar(atual)
    if ('guardrails' in d && d.guardrails) guardrails.push(...d.guardrails)
    if ('estado' in d && d.estado) {
      patches.push(d.estado)
      atual = { ...atual, estado: { ...atual.estado, ...d.estado } }
    }
    if ('efeitos' in d && d.efeitos) efeitos.push(...d.efeitos)
    if (d.tipo !== 'segue') return { decisao: d, instrucoes, estado: juntarPatches(patches), guardrails, prefixo, efeitos }
    if (d.instrucoes) instrucoes.push(...d.instrucoes)
    if (d.prefixo) prefixo.push(...d.prefixo)
  }
  return { decisao: { tipo: 'segue' }, instrucoes, estado: juntarPatches(patches), guardrails, prefixo, efeitos }
}

export interface ResultadoCadeiaPos {
  readonly mensagens: readonly string[]
  readonly guardrails: readonly MarcaGuardrail[]
  readonly bloqueio: NonNullable<ResultadoPosResposta['bloquear']> | null
  readonly estado: PatchEstado
}

/**
 * Roda números → filtro → pergunta → qualidade sobre a resposta. Cada etapa
 * recebe as mensagens que a anterior devolveu. `bloquear` encerra a cadeia.
 */
export async function rodarPosResposta(
  p: PipelineDoTurno, ctx: ContextoPipeline, entrada: EntradaPosResposta,
): Promise<ResultadoCadeiaPos> {
  let mensagens = entrada.mensagens
  const guardrails: MarcaGuardrail[] = []
  const patches: PatchEstado[] = []
  let atual = ctx
  for (const etapa of etapasPosResposta(p)) {
    const r = await etapa.executar(atual, { ...entrada, mensagens })
    guardrails.push(...r.guardrails)
    if (r.estado) {
      patches.push(r.estado)
      atual = { ...atual, estado: { ...atual.estado, ...r.estado } }
    }
    if (r.bloquear) {
      return { mensagens: r.bloquear.mensagensSubstitutas ?? [], guardrails, bloqueio: r.bloquear, estado: juntarPatches(patches) }
    }
    mensagens = r.mensagens
  }
  return { mensagens, guardrails, bloqueio: null, estado: juntarPatches(patches) }
}
