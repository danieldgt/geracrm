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

/** Resposta de `GET /v1/pedidos/contadores`: totais por estado no escopo e filtros da lista. */
export interface ContadoresPedidos {
  readonly porEstado: Readonly<Record<string, { readonly quantidade: number; readonly valorCentavos: number }>>
  readonly total: number
  readonly valorTotalCentavos: number
}

export interface Indicadores {
  readonly efetivados: number
  readonly valorEfetivadoCentavos: number
  readonly rascunhos: number
  readonly falharam: number
}

/** Cards a partir dos contadores do SERVIDOR (valor em centavos inteiros); estado ausente conta zero. */
export function indicadoresDosContadores(c: ContadoresPedidos): Indicadores {
  const de = (e: string) => c.porEstado[e] ?? { quantidade: 0, valorCentavos: 0 }
  return {
    efetivados: de('efetivado').quantidade, valorEfetivadoCentavos: de('efetivado').valorCentavos,
    rascunhos: de('rascunho').quantidade, falharam: de('falhou').quantidade,
  }
}

/** Query da lista e dos contadores: vazio some; período só vale com os DOIS extremos (a API recusa meio período). */
export function montarQueryPedidos(f: {
  estado?: string; contatoId?: string | null; q?: string; inicio?: string; fim?: string; cursor?: string | null
}): URLSearchParams {
  const p = new URLSearchParams()
  if (f.estado) p.set('estado', f.estado)
  if (f.contatoId) p.set('contatoId', f.contatoId)
  const q = (f.q ?? '').trim().slice(0, 100)
  if (q) p.set('q', q)
  if (f.inicio && f.fim) { p.set('inicio', f.inicio); p.set('fim', f.fim) }
  if (f.cursor) p.set('cursor', f.cursor)
  return p
}

/** Estados que a lista filtra (`?estado=`), na ordem das abas. A chave vazia é "Todos". */
export const ESTADOS_FILTRO: readonly { readonly chave: string; readonly rotulo: string }[] = [
  { chave: '', rotulo: 'Todos' },
  { chave: 'rascunho', rotulo: 'Rascunhos' },
  { chave: 'aguardando_confirmacao', rotulo: 'Aguardando SIM' },
  { chave: 'confirmado', rotulo: 'Confirmados' },
  { chave: 'efetivado', rotulo: 'No ERP' },
  { chave: 'falhou', rotulo: 'Falharam' },
]

/** Id da aba "Todos" (aba não aceita id vazio). */
export const ABA_TODOS = 'todos'

/**
 * Abas de estado com a contagem do SERVIDOR no rótulo — substituem os cartões de contagem, que
 * repetiam o filtro (plano de reorganização, F3). Sem contadores, a aba fica sem número (nunca um
 * zero falso); "Todos" usa o total.
 */
export function abasDeEstado(
  c: ContadoresPedidos | null,
): { readonly id: string; readonly rotulo: string; readonly contador?: number }[] {
  return ESTADOS_FILTRO.map((f) => {
    const id = f.chave || ABA_TODOS
    if (!c) return { id, rotulo: f.rotulo }
    const contador = f.chave ? (c.porEstado[f.chave]?.quantidade ?? 0) : c.total
    return { id, rotulo: f.rotulo, contador }
  })
}
