/**
 * Regras PURAS da tela de Consumo (F2) — sem Angular, testadas em consumo.regras.spec.ts.
 * Dinheiro em centavos inteiros; percentuais em inteiros.
 */
export { projetarMes, alertaDoOrcamento, diasDoMes } from '@geracrm/shared'

export interface PontoSerie {
  readonly dia: string
  readonly whatsappCentavos: number
  readonly iaCentavos: number
  readonly transcricaoCentavos: number
}

export type FonteConsumo = 'whatsapp' | 'ia' | 'transcricao'

export interface SegmentoBarra {
  readonly fonte: FonteConsumo
  readonly centavos: number
  /** Altura do segmento em % da barra mais alta (inteiro). */
  readonly alturaPct: number
}

export interface BarraEmpilhada {
  readonly dia: string
  /** Dia do mês, para o eixo ("1", "15"). */
  readonly diaCurto: string
  readonly totalCentavos: number
  readonly segmentos: readonly SegmentoBarra[]
}

export const FONTES: readonly { readonly fonte: FonteConsumo; readonly rotulo: string }[] = [
  { fonte: 'whatsapp', rotulo: 'WhatsApp' },
  { fonte: 'ia', rotulo: 'IA' },
  { fonte: 'transcricao', rotulo: 'Transcrição' },
]

/**
 * Empilha a série diária. A altura de cada segmento sai da diferença entre acumulados arredondados:
 * a soma dos segmentos é SEMPRE o total arredondado (arredondar segmento a segmento deixaria a
 * barra maior ou menor que o valor).
 */
export function empilhar(serie: readonly PontoSerie[]): { barras: readonly BarraEmpilhada[]; maximoCentavos: number } {
  const totais = serie.map((p) => p.whatsappCentavos + p.iaCentavos + p.transcricaoCentavos)
  const maximo = totais.reduce((m, t) => Math.max(m, t), 0)
  const barras = serie.map((p, i) => {
    const valores: readonly [FonteConsumo, number][] = [
      ['whatsapp', p.whatsappCentavos], ['ia', p.iaCentavos], ['transcricao', p.transcricaoCentavos],
    ]
    let acumulado = 0
    let baseAnterior = 0
    const segmentos = valores.map(([fonte, centavos]) => {
      acumulado += centavos
      const base = maximo === 0 ? 0 : Math.round((acumulado * 100) / maximo)
      const seg: SegmentoBarra = { fonte, centavos, alturaPct: base - baseAnterior }
      baseAnterior = base
      return seg
    })
    return { dia: p.dia, diaCurto: String(Number(p.dia.slice(8, 10))), totalCentavos: totais[i]!, segmentos }
  })
  return { barras, maximoCentavos: maximo }
}

/** Mês anterior de 'YYYY-MM'. */
export function mesAnterior(mes: string): string {
  const [a, m] = mes.split('-').map(Number) as [number, number]
  return m === 1 ? `${a - 1}-12` : `${a}-${String(m - 1).padStart(2, '0')}`
}

/** Mês seguinte de 'YYYY-MM'. */
export function mesSeguinte(mes: string): string {
  const [a, m] = mes.split('-').map(Number) as [number, number]
  return m === 12 ? `${a + 1}-01` : `${a}-${String(m + 1).padStart(2, '0')}`
}

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']

/** '2026-10' → 'outubro de 2026'. */
export function rotuloMes(mes: string): string {
  const [a, m] = mes.split('-').map(Number) as [number, number]
  return `${MESES[m - 1] ?? mes} de ${a}`
}

/** Mês de hoje no navegador ('YYYY-MM'); a API devolve o mês no fuso do tenant quando não se informa. */
export function mesDeHoje(agora: Date = new Date()): string {
  return `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, '0')}`
}

/** Percentual inteiro do gasto sobre o orçamento (pode passar de 100). null sem orçamento. */
export function percentualDoOrcamento(gastoCentavos: number, orcamentoCentavos: number | null): number | null {
  if (orcamentoCentavos === null || orcamentoCentavos <= 0) return null
  return Math.floor((gastoCentavos * 100) / orcamentoCentavos)
}

const ROTULO_CATEGORIA: Readonly<Record<string, string>> = {
  marketing: 'Marketing', utility: 'Utilidade', authentication: 'Autenticação', service: 'Atendimento (janela de 24h)',
}
export function rotuloCategoria(c: string): string { return ROTULO_CATEGORIA[c] ?? c }

const ROTULO_FINALIDADE: Readonly<Record<string, string>> = {
  agente_vendedor: 'Agente vendedor', agente_sombra: 'Agente em sombra', simulacao: 'Simulação (playground)', qualidade: 'Juiz de qualidade',
}
export function rotuloFinalidade(f: string): string { return ROTULO_FINALIDADE[f] ?? f }

/** Texto da data do eixo/tooltip: '2026-10-05' → '05/10'. */
export function diaMesCurto(dia: string): string { return `${dia.slice(8, 10)}/${dia.slice(5, 7)}` }
