import { z } from 'zod'

/**
 * CATÁLOGO — contratos compartilhados (ADR-025).
 *
 * ⚠️ O catálogo tem ORIGEM MÚLTIPLA: o ERP sincroniza, e o dono cadastra à mão
 * (planos SaaS, roupas de uma loja sem ERP). As duas origens convivem na mesma
 * tabela, e a origem fica gravada por registro — o integrador nunca sobrescreve
 * o que é manual (ADR-008, origem por campo).
 *
 * Só tipos, Zod e regras puras: este arquivo é consumido por Angular, Expo e API.
 */

export const ORIGENS_CATALOGO = ['erp', 'manual'] as const
export type OrigemCatalogo = (typeof ORIGENS_CATALOGO)[number]

/** O "sistema" de uma tabela de preço ou saldo manual. ERP usa `erp:<conexao_id>`. */
export const SISTEMA_MANUAL = 'manual'

const texto = (max: number) => z.string().trim().min(1).max(max)

/** Atributos abertos do SKU (ADR-004): {"cor":"VERDE","tamanho":"G"} ou {"ciclo":"mensal"}. */
export const atributosSku = z.record(z.string().trim().min(1).max(40), z.string().trim().max(80))
export type AtributosSku = z.infer<typeof atributosSku>

export const produtoEntrada = z.object({
  referencia: texto(60),
  descricao: texto(160),
  descricaoLonga: z.string().trim().max(4000).optional(),
  categoria: z.string().trim().max(80).optional(),
  /** URLs públicas ou chaves de mídia; a tela mostra a primeira. */
  imagens: z.array(z.string().trim().url().max(500)).max(10).optional(),
  ativo: z.boolean().optional(),
})
export type ProdutoEntrada = z.infer<typeof produtoEntrada>

export const skuEntrada = z.object({
  atributos: atributosSku.optional(),
  codigoBarras: z.string().trim().max(40).optional(),
  ativo: z.boolean().optional(),
  /** Preço por perfil, em CENTAVOS. Ausente = sem preço naquele perfil. */
  precos: z.object({
    varejo: z.number().int().nonnegative().optional(),
    atacado: z.number().int().nonnegative().optional(),
  }).optional(),
  /** Saldo manual (null = não controla estoque, vende sob demanda). */
  saldo: z.number().nonnegative().nullable().optional(),
})
export type SkuEntrada = z.infer<typeof skuEntrada>

/** O que uma busca de catálogo devolve — igual para tela, app e agente. */
export interface SkuResumo {
  readonly id: string
  readonly atributos: AtributosSku
  readonly precoCentavos: number | null
  /** null = não controla estoque. */
  readonly saldo: number | null
  readonly saldoEm: string | null
  readonly ativo: boolean
}

export interface ProdutoResumo {
  readonly id: string
  readonly referencia: string
  readonly descricao: string
  readonly descricaoLonga: string | null
  readonly categoria: string | null
  readonly imagem: string | null
  readonly origem: OrigemCatalogo
  readonly skus: readonly SkuResumo[]
}

/**
 * Texto que vai para o índice de busca (FTS/trgm/embedding) de um produto.
 * ⚠️ NUNCA inclui preço nem estoque: mudam sozinhos e variam por tabela do
 * cliente — o modelo os obtém por ferramenta, no turno (ADR-026).
 */
export function textoParaIndice(p: {
  referencia: string; descricao: string; descricaoLonga?: string | null; categoria?: string | null
  atributos: readonly AtributosSku[]
}): string {
  const valores = new Map<string, Set<string>>()
  for (const a of p.atributos) {
    for (const [k, v] of Object.entries(a)) {
      if (!v) continue
      if (!valores.has(k)) valores.set(k, new Set())
      valores.get(k)!.add(v)
    }
  }
  const atributos = [...valores.entries()]
    .map(([k, vs]) => `${k}: ${[...vs].join(', ')}`)
    .join('; ')
  return [p.referencia, p.descricao, p.categoria ?? '', p.descricaoLonga ?? '', atributos]
    .map((s) => s.trim()).filter(Boolean).join('\n')
}
