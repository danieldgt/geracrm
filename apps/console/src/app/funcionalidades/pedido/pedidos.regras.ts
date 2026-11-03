/** Regras puras da lista de pedidos — sem DOM, testadas em node. */

/** Tom do `ui-badge` (mesma união que o componente aceita). */
export type TomBadge = 'neutro' | 'sucesso' | 'atencao' | 'erro' | 'info'

const ROTULOS: Readonly<Record<string, string>> = {
  rascunho: 'Rascunho', aguardando_confirmacao: 'Aguardando SIM', confirmado: 'Confirmado',
  efetivado: 'No ERP', falhou: 'Falhou', cancelado: 'Cancelado',
  aguardando_conferencia: 'Conferência', enviando: 'Enviando', validando: 'Validando',
}

const TONS: Readonly<Record<string, TomBadge>> = {
  rascunho: 'neutro', aguardando_confirmacao: 'atencao', confirmado: 'info', efetivado: 'sucesso',
  falhou: 'erro', cancelado: 'neutro', aguardando_conferencia: 'atencao', enviando: 'info', validando: 'info',
}

export function rotuloDoEstado(estado: string): string {
  return ROTULOS[estado] ?? estado
}

/** Tom por estado: o que pede atenção é âmbar/vermelho; o que está andando é azul; o resto é neutro. */
export function tomDoEstado(estado: string): TomBadge {
  return TONS[estado] ?? 'neutro'
}

/** Variação da grade (cor · tamanho · …) na ordem de leitura do operador. */
export function variacaoDaGrade(grade: Record<string, string> | null | undefined): string {
  if (!grade) return ''
  const ordem = ['cor', 'tamanho', 'subTamanho']
  const vistos = new Set<string>()
  const partes: string[] = []
  for (const chave of ordem) {
    const valor = grade[chave]
    if (valor) { partes.push(valor); vistos.add(chave) }
  }
  for (const [chave, valor] of Object.entries(grade)) if (!vistos.has(chave) && valor) partes.push(valor)
  return partes.join(' · ')
}

/** Data e hora curtas, pt-BR. Para lista e detalhe. */
export function formatarDataHora(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
}

export interface LinhaIndicador { readonly estado: string; readonly totalCentavos: number }

export interface Indicadores {
  readonly efetivados: number
  readonly valorEfetivadoCentavos: number
  readonly rascunhos: number
  readonly falharam: number
}

/**
 * Contadores dos cards, calculados SÓ sobre o que está carregado (a API não devolve totais).
 * O valor é soma de centavos inteiros (ADR de dinheiro).
 */
export function indicadoresDaLista(linhas: readonly LinhaIndicador[]): Indicadores {
  let efetivados = 0
  let valorEfetivadoCentavos = 0
  let rascunhos = 0
  let falharam = 0
  for (const l of linhas) {
    if (l.estado === 'efetivado') { efetivados++; valorEfetivadoCentavos += l.totalCentavos }
    else if (l.estado === 'rascunho') rascunhos++
    else if (l.estado === 'falhou') falharam++
  }
  return { efetivados, valorEfetivadoCentavos, rascunhos, falharam }
}

export interface LinhaBusca {
  readonly contato: string | null
  readonly rotulo: string | null
  readonly numeroExterno: string | null
}

/** Busca no cliente, só sobre o que já foi carregado: cliente, nome do pedido ou nº ERP. */
export function filtrarPorTermo<T extends LinhaBusca>(itens: readonly T[], termo: string): readonly T[] {
  const alvo = termo.trim().toLocaleLowerCase('pt-BR')
  if (alvo === '') return itens
  return itens.filter((p) =>
    [p.contato, p.rotulo, p.numeroExterno].some((campo) => (campo ?? '').toLocaleLowerCase('pt-BR').includes(alvo)))
}
