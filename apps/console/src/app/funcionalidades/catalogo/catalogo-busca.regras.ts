import type { FonteBuscaCatalogo, ResumoBuscaInteligente, SituacaoSemantica } from '@geracrm/shared'

/**
 * Busca do Catálogo: "inteligente" (a busca híbrida do agente, ranqueada — ADR-026) ou
 * "por trecho" (ILIKE em referência e descrição, paginada por cursor).
 *
 * ⚠️ A inteligente só vale com texto digitado e sem "Mostrar inativos": o índice de busca
 *    é só do catálogo ativo (é o que o agente oferece). Fora disso a tela cai na lista por
 *    trecho — e diz por quê, em vez de trocar de modo calada.
 */
export const MODOS_BUSCA = ['inteligente', 'trecho'] as const
export type ModoBusca = (typeof MODOS_BUSCA)[number]

export function usaBuscaInteligente(modo: ModoBusca, busca: string, inativos: boolean): boolean {
  return modo === 'inteligente' && busca.trim() !== '' && !inativos
}

const ROTULO_FONTE: Record<FonteBuscaCatalogo, string> = {
  lexical: 'palavras', trgm: 'grafia aproximada', semantica: 'significado',
}

const MOTIVO_SEM_SIGNIFICADO: Record<Exclude<SituacaoSemantica, 'ligada'>, string> = {
  sem_chave: 'A busca por significado está desligada: falta configurar o provedor de embedding no servidor.',
  sem_indice: 'A busca por significado está desligada: o banco não tem o índice vetorial (pgvector).',
  indisponivel: 'O provedor de significado não respondeu agora; esta busca usou só palavras e grafia aproximada.',
}

/** "palavras, grafia aproximada e significado" — na ordem fixa das pernas. */
function listar(fontes: readonly FonteBuscaCatalogo[]): string {
  const nomes = (['lexical', 'trgm', 'semantica'] as const).filter((f) => fontes.includes(f)).map((f) => ROTULO_FONTE[f])
  if (nomes.length <= 1) return nomes[0] ?? 'palavras'
  return `${nomes.slice(0, -1).join(', ')} e ${nomes[nomes.length - 1]}`
}

export interface DescricaoBusca {
  /** Uma linha: o que a lista mostra e como foi achada. */
  readonly resumo: string
  /** Avisos de degradação ou de corte, cada um com o que fazer. */
  readonly avisos: readonly string[]
}

export function descreverBusca(r: ResumoBuscaInteligente, mostrados: number): DescricaoBusca {
  const quantos = mostrados === 1 ? '1 produto' : `${mostrados} produtos`
  const avisos: string[] = []
  if (r.truncado) avisos.push(`Mostrando os ${mostrados} mais próximos. Refine a busca para ver outros.`)
  if (r.semantica !== 'ligada') avisos.push(MOTIVO_SEM_SIGNIFICADO[r.semantica])
  return { resumo: `Busca inteligente: ${quantos}, do mais ao menos relevante, por ${listar(r.fontes)}.`, avisos }
}

/** Por que a tela está na busca por trecho apesar do modo inteligente — `null` = não está. */
export function motivoBuscaPorTrecho(modo: ModoBusca, busca: string, inativos: boolean): string | null {
  if (modo === 'inteligente' && busca.trim() !== '' && inativos) {
    return 'Com "Mostrar inativos", a busca é por trecho: o índice inteligente só tem os produtos ativos.'
  }
  return null
}
