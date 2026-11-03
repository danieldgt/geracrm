import type { ColunaCsv } from '../../compartilhado/ui/csv.js'

/** Item devolvido por `GET /v1/relatorios/contatos-por/:dimensao`. `taxa` é 0..1 (null sem contatos). */
export interface ItemRelatorio {
  readonly chave: string
  readonly rotulo: string
  readonly contatos: number
  readonly convertidos: number
  readonly taxa: number | null
  readonly valorCentavos: number
}

export interface BarraEscalada {
  readonly chave: string; readonly rotulo: string; readonly valor: number
  /** Texto do valor à direita da barra (ex.: "R$ 10,00 (12%)"); sem ele, o próprio número. */
  readonly texto?: string
  readonly largura: number
}

/** Largura mínima (em %) de uma barra com valor maior que zero: some-e-aparece é pior que exagerar 2%. */
export const LARGURA_MINIMA = 2

/**
 * Escala das barras: o MAIOR valor ocupa 100% e os demais são proporcionais. Zero fica em 0 (sem barra);
 * qualquer valor positivo tem ao menos LARGURA_MINIMA. Sem valores positivos, todas em 0.
 */
export function escalarBarras(itens: readonly { chave: string; rotulo: string; valor: number; texto?: string }[]): BarraEscalada[] {
  const maior = itens.reduce((m, i) => Math.max(m, i.valor), 0)
  return itens.map((i) => ({
    ...i,
    largura: maior <= 0 || i.valor <= 0 ? 0 : Math.max(LARGURA_MINIMA, Math.round((i.valor / maior) * 1000) / 10),
  }))
}

/** Query do período: vazia quando faltar uma das pontas (a API assume o mês atual). */
export function queryDoPeriodo(inicio: string, fim: string): string {
  if (!inicio || !fim) return ''
  return `inicio=${encodeURIComponent(inicio)}&fim=${encodeURIComponent(fim)}`
}

/** "12,3%" a partir de 0..1; "—" sem taxa. */
export function formatarTaxa(taxa: number | null): string {
  if (taxa === null) return '—'
  return `${(taxa * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`
}

/** Totais dos cards resumo. A taxa é a do conjunto (convertidos totais / contatos totais), nunca a média das taxas. */
export function resumoDoRelatorio(itens: readonly ItemRelatorio[]): {
  contatos: number; convertidos: number; taxa: number | null; valorCentavos: number
} {
  const contatos = itens.reduce((s, i) => s + i.contatos, 0)
  const convertidos = itens.reduce((s, i) => s + i.convertidos, 0)
  return {
    contatos, convertidos,
    taxa: contatos > 0 ? Math.round((convertidos / contatos) * 10_000) / 10_000 : null,
    valorCentavos: itens.reduce((s, i) => s + i.valorCentavos, 0),
  }
}

export const COLUNAS_CSV: readonly ColunaCsv[] = [
  { chave: 'rotulo', rotulo: 'Grupo' },
  { chave: 'contatos', rotulo: 'Contatos' },
  { chave: 'convertidos', rotulo: 'Convertidos' },
  { chave: 'taxa', rotulo: 'Conversão (%)' },
  { chave: 'valor', rotulo: 'Valor (R$)' },
]

/** Linhas do CSV: taxa em % e valor em reais NUMÉRICOS (o `paraCsv` põe a vírgula decimal); sem taxa, célula vazia. */
export function linhasCsv(itens: readonly ItemRelatorio[], rotuloGrupo = 'Grupo'): { colunas: ColunaCsv[]; linhas: Record<string, unknown>[] } {
  return {
    colunas: COLUNAS_CSV.map((c) => (c.chave === 'rotulo' ? { ...c, rotulo: rotuloGrupo } : c)),
    linhas: itens.map((i) => ({
      rotulo: i.rotulo,
      contatos: i.contatos,
      convertidos: i.convertidos,
      taxa: i.taxa === null ? null : Math.round(i.taxa * 10_000) / 100,
      valor: i.valorCentavos / 100,
    })),
  }
}
