/**
 * Regras PURAS do panorama e dos filtros do board do funil (B1) — sem DOM, sem HTTP.
 * A URL é a fonte da verdade: visão, agrupamento e filtros vivem nos query params, para compartilhar o link.
 */

export type Visao = 'panorama' | 'board'
export type Agrupar = 'filial' | 'vendedor'

export interface FiltrosBoard {
  readonly busca: string
  readonly vendedorId: string
  readonly filialId: string
  readonly etiquetaId: string
  readonly origemId: string
}
export interface EstadoDaUrl { readonly visao: Visao; readonly agrupar: Agrupar; readonly filtros: FiltrosBoard }

export const SEM_DONO = 'sem-dono'
export const SEM_FILIAL = 'sem-filial'
/** Cartões do panorama mostrados de cada vez; o resto vem por "carregar mais" (a API devolve até 200 grupos). */
export const PAGINA_PANORAMA = 60

export const FILTROS_VAZIOS: FiltrosBoard = { busca: '', vendedorId: '', filialId: '', etiquetaId: '', origemId: '' }

/** Nome do query param de cada filtro (a API usa `q` para a busca; a URL da tela também). */
const PARAM_DE: Readonly<Record<keyof FiltrosBoard, string>> = {
  busca: 'q', vendedorId: 'vendedorId', filialId: 'filialId', etiquetaId: 'etiquetaId', origemId: 'origemId',
}
const CHAVES = Object.keys(PARAM_DE) as (keyof FiltrosBoard)[]

type Params = Readonly<Record<string, string | null | undefined>>

/** URL -> estado. Valor inválido cai no padrão (panorama por filial, sem filtros). */
export function lerQueryParams(p: Params): EstadoDaUrl {
  const filtros = { ...FILTROS_VAZIOS } as Record<keyof FiltrosBoard, string>
  for (const k of CHAVES) filtros[k] = (p[PARAM_DE[k]] ?? '').trim()
  return {
    visao: p['visao'] === 'board' ? 'board' : 'panorama',
    agrupar: p['agrupar'] === 'vendedor' ? 'vendedor' : 'filial',
    filtros,
  }
}

/**
 * Estado -> query params para `router.navigate`. Valor vazio vira `null` (o Angular remove o param);
 * o padrão (panorama, filial) também não aparece na URL.
 */
export function paraQueryParams(e: EstadoDaUrl): Record<string, string | null> {
  const r: Record<string, string | null> = {
    visao: e.visao === 'board' ? 'board' : null,
    agrupar: e.agrupar === 'vendedor' ? 'vendedor' : null,
  }
  for (const k of CHAVES) r[PARAM_DE[k]] = e.filtros[k].trim() || null
  return r
}

/** Query string da API (`?vendedorId=…&q=…`), sem `visao`/`agrupar`. Vazio quando não há filtro. */
export function queryDaApi(f: FiltrosBoard): string {
  const u = new URLSearchParams()
  for (const k of CHAVES) {
    const v = f[k].trim()
    if (v) u.set(PARAM_DE[k], v)
  }
  const s = u.toString()
  return s ? `?${s}` : ''
}

export function contarFiltros(f: FiltrosBoard): number {
  return CHAVES.filter((k) => f[k].trim() !== '').length
}

/** O que clicar num cartão do panorama aplica ao board: o grupo vira filtro (e os demais filtros saem). */
export function filtrosDoGrupo(agrupar: Agrupar, chave: string): FiltrosBoard {
  if (chave === SEM_DONO) return { ...FILTROS_VAZIOS, vendedorId: SEM_DONO }
  return agrupar === 'vendedor' ? { ...FILTROS_VAZIOS, vendedorId: chave } : { ...FILTROS_VAZIOS, filialId: chave }
}

// ── Cartões do panorama ──

export interface GrupoPanorama {
  readonly chave: string
  readonly rotulo: string
  readonly ativos: number
  readonly ganhosMes: number
  readonly perdidosMes: number
  readonly semProximoPasso: number
  readonly porEtapa: readonly { readonly etapaId: string; readonly total: number }[]
}
export type TomSelo = 'neutro' | 'sucesso' | 'atencao' | 'erro' | 'info'
export interface Selo { readonly id: 'ativos' | 'ganhos' | 'semPasso' | 'perdidos'; readonly rotulo: string; readonly valor: number; readonly tom: TomSelo }
export interface CartaoPanorama {
  readonly chave: string
  readonly rotulo: string
  readonly selos: readonly Selo[]
  readonly etapas: readonly { readonly etapaId: string; readonly nome: string; readonly total: number }[]
  readonly semDono: boolean
}

/**
 * Monta o cartão de cada grupo. "Sem próximo passo" leva COR (atenção, só quando > 0) e RÓTULO — a cor nunca
 * é o único sinal. A contagem por etapa segue a ordem das etapas do funil, não a da resposta.
 */
export function montarCartoes(
  grupos: readonly GrupoPanorama[], etapas: readonly { readonly id: string; readonly nome: string }[],
): CartaoPanorama[] {
  return grupos.map((g) => {
    const total = new Map(g.porEtapa.map((e) => [e.etapaId, e.total]))
    return {
      chave: g.chave,
      rotulo: g.rotulo,
      semDono: g.chave === SEM_DONO,
      selos: [
        { id: 'ativos', rotulo: 'ativos', valor: g.ativos, tom: 'info' },
        { id: 'ganhos', rotulo: 'ganhos no mês', valor: g.ganhosMes, tom: g.ganhosMes > 0 ? 'sucesso' : 'neutro' },
        { id: 'semPasso', rotulo: 'sem próximo passo', valor: g.semProximoPasso, tom: g.semProximoPasso > 0 ? 'atencao' : 'neutro' },
        { id: 'perdidos', rotulo: 'perdidos no mês', valor: g.perdidosMes, tom: g.perdidosMes > 0 ? 'erro' : 'neutro' },
      ] as const,
      etapas: etapas.map((e) => ({ etapaId: e.id, nome: e.nome, total: total.get(e.id) ?? 0 })),
    }
  })
}

/** Quantos cartões mostrar: `visiveis` cresce de PAGINA_PANORAMA em PAGINA_PANORAMA. */
export function cartoesVisiveis<T>(cartoes: readonly T[], visiveis: number): { itens: readonly T[]; temMais: boolean; restantes: number } {
  const itens = cartoes.slice(0, Math.max(visiveis, 0))
  return { itens, temMais: cartoes.length > itens.length, restantes: Math.max(cartoes.length - itens.length, 0) }
}
