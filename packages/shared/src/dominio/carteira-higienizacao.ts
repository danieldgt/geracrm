import type { AgrupamentoCockpit } from './cockpit.js'

/**
 * Higienização da carteira (D2). "Ativo" = contato qualificado OU com oportunidade aberta; "com próximo
 * passo" = a regra de `semProximoPasso` (tarefa aberta futura ou, com a Agenda ligada, evento futuro).
 * O indicador é a fração dos ativos que tem próximo passo, contra a meta.
 */

/** Meta de cobertura, em %. */
export const META_PROXIMO_PASSO = 95
/** Abaixo disto o indicador é crítico; entre isto e a meta, atenção. */
export const LIMITE_ATENCAO_PROXIMO_PASSO = 80

export type EstadoContraMeta = 'atingida' | 'atencao' | 'critica'

export interface IndicadorCarteira {
  readonly ativos: number
  readonly comProximoPasso: number
  readonly semProximoPasso: number
  /** 0–100, uma casa decimal. Sem ativos = 100 (nada a higienizar). */
  readonly percentual: number
  readonly meta: number
}

export interface GrupoIndicadorCarteira extends IndicadorCarteira {
  /** uuid do grupo ou `sem` (contato sem dono / sem filial). */
  readonly chave: string
  readonly rotulo: string
}

export interface RespostaGruposIndicador {
  readonly agrupar: AgrupamentoCockpit
  readonly grupos: readonly GrupoIndicadorCarteira[]
}

/** Percentual com uma casa; entradas inválidas (negativo, com > ativos) são limitadas. */
export function percentualComProximoPasso(ativos: number, comProximoPasso: number): number {
  if (!(ativos > 0)) return 100
  const com = Math.min(Math.max(comProximoPasso, 0), ativos)
  return Math.round((com * 1000) / ativos) / 10
}

export function estadoContraMeta(percentual: number, meta: number = META_PROXIMO_PASSO): EstadoContraMeta {
  if (percentual >= meta) return 'atingida'
  if (percentual >= LIMITE_ATENCAO_PROXIMO_PASSO) return 'atencao'
  return 'critica'
}

/** Quantos contatos faltam agendar para chegar à meta (0 se já atingida). */
export function faltamParaMeta(ativos: number, comProximoPasso: number, meta: number = META_PROXIMO_PASSO): number {
  if (!(ativos > 0)) return 0
  return Math.max(0, Math.ceil((ativos * meta) / 100) - Math.max(comProximoPasso, 0))
}

export function montarIndicador(ativos: number, comProximoPasso: number): IndicadorCarteira {
  const total = Math.max(ativos, 0)
  const com = Math.min(Math.max(comProximoPasso, 0), total)
  return { ativos: total, comProximoPasso: com, semProximoPasso: total - com, percentual: percentualComProximoPasso(total, com), meta: META_PROXIMO_PASSO }
}
