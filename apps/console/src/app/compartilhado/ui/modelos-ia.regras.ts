/**
 * Regras PURAS de apresentação do catálogo de modelos de IA (0093) — sem DOM,
 * sem Angular. Usadas pela tela do agente (o cliente escolhe) e pela
 * Plataforma → Clientes (o staff libera): por isso moram em `compartilhado`,
 * e não numa funcionalidade.
 *
 * Quem decide o quê está em docs/estudo-modelos-llm.md §3. A chave do
 * fornecedor é do servidor: nada aqui conhece credencial.
 */

export const PROVEDORES_IA = ['claude', 'openrouter', 'groq', 'gemini', 'cerebras', 'maritaca'] as const
export type ProvedorIa = (typeof PROVEDORES_IA)[number]

export interface ModeloIa {
  readonly codigo: string
  readonly provedor: ProvedorIa | string
  readonly modelo: string
  readonly nome: string
  readonly descricao: string
  readonly gratuito: boolean
  readonly ferramentas: boolean
  readonly saidaEstruturada: boolean
  readonly qualidade: number
  readonly custoEntradaUsdMilhao: number
  readonly custoSaidaUsdMilhao: number
  readonly janelaContexto: number
  readonly observacao: string
  readonly padrao: boolean
  readonly disponivel: boolean
  readonly motivoIndisponivel: string | null
}

export type ModeloComPermissao = ModeloIa & { readonly permitido: boolean }

const ROTULO_PROVEDOR: Readonly<Record<ProvedorIa, string>> = {
  claude: 'Anthropic',
  openrouter: 'OpenRouter',
  groq: 'Groq',
  gemini: 'Google Gemini',
  cerebras: 'Cerebras',
  maritaca: 'Maritaca',
}

/** Nome do fornecedor para a tela; desconhecido (API mais nova) sai cru. */
export function rotuloProvedor(p: string): string {
  return (ROTULO_PROVEDOR as Readonly<Record<string, string>>)[p] ?? p
}

export const QUALIDADE_MAX = 5

/**
 * Cinco posições, preenchidas até a qualidade. ⚠️ Fora da faixa não quebra a
 * tela: 0 ou negativo vira tudo vazio, acima de 5 vira tudo cheio.
 */
export function pontosQualidade(q: number): readonly boolean[] {
  const n = Number.isFinite(q) ? Math.min(QUALIDADE_MAX, Math.max(0, Math.round(q))) : 0
  return Array.from({ length: QUALIDADE_MAX }, (_, i) => i < n)
}

/** O que o leitor de tela anuncia no lugar dos pontos. */
export function rotuloQualidade(q: number): string {
  const n = pontosQualidade(q).filter(Boolean).length
  return `Qualidade ${n} de ${QUALIDADE_MAX}`
}

/** 0.15 → "0,15"; 3 → "3"; 0.075 → "0,075". Sem Intl: não pode variar por ambiente. */
export function formatarUsd(n: number): string {
  if (!Number.isFinite(n)) return '0'
  const fixo = n.toFixed(3).replace(/\.?0+$/, '')
  return fixo.replace('.', ',')
}

/**
 * "US$ 0,15 / 0,60 por 1M tokens" (entrada / saída). ⚠️ `null` quando os dois
 * custos são zero — modelo gratuito não exibe linha de custo, exibe o badge.
 */
export function linhaDeCusto(m: Pick<ModeloIa, 'custoEntradaUsdMilhao' | 'custoSaidaUsdMilhao'>): string | null {
  if (m.custoEntradaUsdMilhao === 0 && m.custoSaidaUsdMilhao === 0) return null
  return `US$ ${formatarUsd(m.custoEntradaUsdMilhao)} / ${formatarUsd(m.custoSaidaUsdMilhao)} por 1M tokens`
}

/** Grátis primeiro, pagos depois — a ordem da API se mantém dentro de cada grupo. */
export function agruparPorPreco<T extends Pick<ModeloIa, 'gratuito'>>(itens: readonly T[]): { gratuitos: T[]; pagos: T[] } {
  return {
    gratuitos: itens.filter((m) => m.gratuito),
    pagos: itens.filter((m) => !m.gratuito),
  }
}

/** Badges em ORDEM FIXA (preço, ferramentas, saída estruturada) — quem varre não lê. */
export function badgesDoModelo(m: Pick<ModeloIa, 'gratuito' | 'ferramentas' | 'saidaEstruturada'>): readonly string[] {
  const b = [m.gratuito ? 'Grátis' : 'Pago']
  if (m.ferramentas) b.push('ferramentas')
  if (m.saidaEstruturada) b.push('saída estruturada')
  return b
}

// ─── Painel do staff: do conjunto de caixas marcadas ao corpo do PUT ─────────

/** Os códigos que a API marcou como permitidos. */
export function permitidosDe(itens: readonly ModeloComPermissao[]): ReadonlySet<string> {
  return new Set(itens.filter((m) => m.permitido).map((m) => m.codigo))
}

/** Marca ou desmarca sem mutar o conjunto original. */
export function alternarCodigo(marcados: ReadonlySet<string>, codigo: string, ligado: boolean): ReadonlySet<string> {
  const n = new Set(marcados)
  if (ligado) n.add(codigo); else n.delete(codigo)
  return n
}

/**
 * O corpo do PUT: os marcados NA ORDEM DO CATÁLOGO, sem repetição e sem código
 * que não exista nele. Lista vazia é legítima: significa "volta ao padrão".
 */
export function codigosParaSalvar(marcados: ReadonlySet<string>, catalogo: readonly Pick<ModeloIa, 'codigo'>[]): string[] {
  return catalogo.map((m) => m.codigo).filter((c) => marcados.has(c))
}

/** Há diferença entre o que está salvo e o que está marcado? Decide se "Salvar" habilita. */
export function mudouPermissao(original: ReadonlySet<string>, atual: ReadonlySet<string>): boolean {
  if (original.size !== atual.size) return true
  for (const c of original) if (!atual.has(c)) return true
  return false
}
