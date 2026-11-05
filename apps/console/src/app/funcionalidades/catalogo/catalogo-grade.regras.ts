/**
 * Grade do produto (cor × tamanho) — regras PURAS, sem DOM e sem HTTP. Skill
 * `grade-cor-tamanho`: a API devolve linhas planas por SKU e o pivot é no
 * cliente (§11); combinação inexistente é `undefined` na matriz (a tela mostra
 * `—`, não 0, §3); tamanhos ordenados por rank, não por ordem alfabética.
 *
 * Saiu de `catalogo.pagina.ts` na fusão de Catálogo com Cadastro de Produtos
 * (2026-11-05): a mesma matriz serve à consulta e ao cadastro.
 */

export interface SkuDaGrade {
  readonly atributos: Record<string, string>
  readonly precoCentavos: number | null
  readonly saldo: number | null
  readonly codigoBarras?: string | null
}
export interface CelulaGrade { readonly saldo: number | null; readonly precoCentavos: number | null; readonly codigoBarras: string | null }
export interface CorGrade { readonly nome: string; readonly hex: string | null }
export interface Grade {
  /** `false` = os SKUs não têm cor E tamanho; a tela lista as variações em vez da matriz. */
  readonly temGrade: boolean
  readonly cores: readonly CorGrade[]
  readonly tamanhos: readonly string[]
  /** Chave `${cor}||${tamanho}`. Ausente = combinação que não existe. */
  readonly celulas: Readonly<Record<string, CelulaGrade>>
  readonly totalCor: Readonly<Record<string, number>>
  readonly totalTam: Readonly<Record<string, number>>
  readonly total: number
}

// Cores comuns (PT) → hex para o swatch. É DADO (a cor real do produto), não token
// de design; a tela mostra swatch + nome, nunca só o hex.
const CORES_HEX: Readonly<Record<string, string>> = {
  PRETO: '#1A1A1A', BRANCO: '#FFFFFF', OFFWHITE: '#F3EFE7', CINZA: '#9AA0A6', 'CINZA CLARO': '#C7CBD1', 'CINZA ESCURO': '#5A5F66', CHUMBO: '#4A4E57', GRAFITE: '#3A3D42', MESCLA: '#B9BdC4',
  VERMELHO: '#D32F2F', VINHO: '#7B1E28', BORDO: '#5E1B25', ROSA: '#E5679B', PINK: '#E5127D', CORAL: '#FF6F61', SALMAO: '#FF8C69',
  LARANJA: '#F27122', AMARELO: '#F5C518', MOSTARDA: '#D6A419', OURO: '#C9A227', BEGE: '#D8C3A5', NUDE: '#E7C6A5', AREIA: '#DAC7A0', MARROM: '#6B4A2B', CAFE: '#4B3621', CAQUI: '#94794B',
  VERDE: '#2E9E5B', 'VERDE MILITAR': '#4B5320', 'VERDE MUSGO': '#5A6B31', 'VERDE AGUA': '#88C9A1', 'VERDE BANDEIRA': '#0B7A3B', LIMAO: '#B5D33D',
  AZUL: '#2C6FBE', 'AZUL MARINHO': '#1B2A4A', MARINHO: '#1B2A4A', 'AZUL CLARO': '#7EA8D9', 'AZUL ROYAL': '#1E4EBF', JEANS: '#3B5A76', TURQUESA: '#0FB5AE',
  ROXO: '#7C5CD6', LILAS: '#B39DDB', VIOLETA: '#7C4DA0', LAVANDA: '#C3B2E0',
}
const TAM_LETRA: Readonly<Record<string, number>> = { PP: 1, P: 2, M: 3, G: 4, GG: 5, XG: 6, EG: 6, XGG: 7, EGG: 7, XXG: 8, EXG: 8, XXGG: 9 }

/** Lê um atributo por chave, ignorando caixa ('cor'/'COR'/'Cor'). */
function ler(a: Record<string, string>, chave: string): string {
  for (const [k, v] of Object.entries(a)) if (k.toLowerCase() === chave) return (v ?? '').trim()
  return ''
}

/** Rank do tamanho: único < letras (PP…XXGG) < números < o resto (alfabético). */
export function rankTamanho(t: string): [number, number, string] {
  const s = t.trim().toUpperCase()
  if (s === 'U' || s === 'UN' || s === 'UNICO' || s === 'ÚNICO') return [0, 0, s]
  if (TAM_LETRA[s] !== undefined) return [1, TAM_LETRA[s]!, s]
  const n = Number(s.replace(',', '.'))
  if (!Number.isNaN(n)) return [2, n, s]
  return [3, 0, s]
}

/** Pivot: linhas planas de SKU → matriz cor × tamanho, com totais (§10: inexistente não entra; saldo nulo conta 0). */
export function montarGrade(skus: readonly SkuDaGrade[]): Grade {
  const coresVistas = new Set<string>()
  const tamanhosVistos = new Set<string>()
  const celulas: Record<string, CelulaGrade> = {}
  for (const s of skus) {
    const cor = ler(s.atributos, 'cor')
    const tam = ler(s.atributos, 'tamanho')
    if (!cor || !tam) continue
    coresVistas.add(cor); tamanhosVistos.add(tam)
    celulas[`${cor}||${tam}`] = { saldo: s.saldo, precoCentavos: s.precoCentavos, codigoBarras: s.codigoBarras ?? null }
  }
  const temGrade = coresVistas.size > 0 && tamanhosVistos.size > 0
  const cores: CorGrade[] = [...coresVistas].sort((a, b) => a.localeCompare(b, 'pt'))
    .map((nome) => ({ nome, hex: CORES_HEX[nome.toUpperCase()] ?? null }))
  const tamanhos = [...tamanhosVistos].sort((a, b) => {
    const ra = rankTamanho(a), rb = rankTamanho(b)
    return ra[0] - rb[0] || ra[1] - rb[1] || ra[2].localeCompare(rb[2])
  })

  const totalCor: Record<string, number> = {}
  const totalTam: Record<string, number> = {}
  let total = 0
  for (const c of cores) {
    let linha = 0
    for (const t of tamanhos) {
      const cel = celulas[`${c.nome}||${t}`]
      if (!cel) continue
      const q = cel.saldo ?? 0
      linha += q; totalTam[t] = (totalTam[t] ?? 0) + q
    }
    totalCor[c.nome] = linha; total += linha
  }
  return { temGrade, cores, tamanhos, celulas, totalCor, totalTam, total }
}

/**
 * Saldo na linha da lista: a soma da grade, ou a soma dos SKUs quando não há grade.
 * `?` se algum SKU não sincronizou o saldo; `sob demanda` se nenhum controla estoque.
 */
export function saldoDaLinha(skus: readonly SkuDaGrade[]): string {
  if (skus.length === 0) return '—'
  if (skus.every((s) => s.saldo === null)) return 'sob demanda'
  const g = montarGrade(skus)
  if (g.temGrade) return String(g.total)
  if (skus.some((s) => s.saldo === null)) return '?'
  return String(skus.reduce((soma, s) => soma + (s.saldo ?? 0), 0))
}

/** Cor muito clara ganha borda no swatch para não sumir no fundo. */
export function corClara(hex: string): boolean {
  const h = hex.replace('#', '')
  if (h.length < 6) return false
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16)
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.82
}
