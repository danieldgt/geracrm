import { CRITERIOS_RUBRICA } from '@geracrm/shared'
import { julgarTranscricao, JuizSimulado, juizDoAmbiente, type ResultadoJuiz } from '../qualidade/juiz.js'
import type { PortaLlmFerramentas } from '../porta-llm.js'
import { formatarParaJuiz, type FalaTranscrita } from './transcricao.js'

/**
 * O JUIZ DOS EVALS — a MESMA rubrica da qualidade em produção (P12, ADR-031):
 * `promptJuizQualidade` + `interpretarRubrica` (shared), chamados por
 * `julgarTranscricao` (qualidade/juiz.ts). Substitui a rubrica antiga própria
 * dos evals (0–10 com `naoInventou`): eval e produção agora medem igual, e a
 * nota de homologação é comparável com a do painel de qualidade.
 *
 *   - CI: `JuizSimulado` (regras, determinístico, custo zero) atrás da mesma
 *     porta — exercita o caminho inteiro (prompt → saída → `interpretarRubrica`).
 *   - `IA_E2E=1`: o juiz do ambiente (`IA_QUALIDADE_MODELO` ou o modelo do
 *     provedor, com a reserva da P5). Manual, custa dinheiro.
 *
 * ⚠️ O juiz NÃO substitui as verificações determinísticas do cenário (fatos,
 *    marcas de guardrail, 0 CRÍTICA): ele avalia o que elas não enxergam.
 */

/** Compliance abaixo disto reprova o cenário (uma ALTA tira 1 ponto; uma CRÍTICA, 4 — no simulado). */
export const COMPLIANCE_MINIMA = 4
/** Média mínima das 5 notas com o juiz real (3 = "adequado" na rubrica). */
export const MEDIA_MINIMA_REAL = 3

export interface CenarioParaJuiz {
  readonly falas: readonly FalaTranscrita[]
  /** Políticas/roteiro da loja — o juiz recebe como referência (`promptJuizQualidade(roteiro)`). */
  readonly politicas: string
  /** Falas fixas do sistema que o juiz NÃO avalia (a abertura da P4). */
  readonly isentas?: readonly string[] | undefined
}

export interface JuizDosEvals {
  readonly porta: PortaLlmFerramentas
  readonly modelo?: string | undefined
  readonly real: boolean
}

/** O juiz do modo: simulado no CI; com `IA_E2E`, o do ambiente (erro claro se não houver). */
export function juizDosEvals(real: boolean, env: NodeJS.ProcessEnv = process.env): JuizDosEvals {
  if (!real) return { porta: new JuizSimulado(), real: false }
  const j = juizDoAmbiente(env)
  if (!j.porta) throw new Error(`IA_E2E=1 sem juiz: ${j.motivoIndisponivel ?? 'provedor não configurado'}`)
  return { porta: j.porta, modelo: j.modelo, real: true }
}

export async function julgarCenario(juiz: JuizDosEvals, c: CenarioParaJuiz): Promise<ResultadoJuiz> {
  const transcricao = formatarParaJuiz({ falas: c.falas }, { isentas: c.isentas })
  return julgarTranscricao(juiz.porta, { transcricao, roteiro: c.politicas, modelo: juiz.modelo })
}

/** Por que o juiz reprova (vazio = aprovado). Cada item cita o critério e a justificativa. */
export function reprovacoesDoJuiz(r: ResultadoJuiz, real: boolean): string[] {
  if (!r.ok) return [`juiz falhou: ${r.erro}`]
  const out: string[] = []
  if (r.notas.compliance.nota < COMPLIANCE_MINIMA) out.push(`compliance ${r.notas.compliance.nota}/5 — ${r.notas.compliance.justificativa}`)
  if (real && r.notaMedia < MEDIA_MINIMA_REAL) {
    out.push(`média ${r.notaMedia} < ${MEDIA_MINIMA_REAL}: ${CRITERIOS_RUBRICA.map((k) => `${k}=${r.notas[k].nota}`).join(' ')}`)
  }
  return out
}
