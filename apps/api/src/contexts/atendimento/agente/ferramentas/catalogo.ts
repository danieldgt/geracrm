import { z } from 'zod'
import type { Ferramenta } from './porta.js'
import type { CatalogoPorta } from './ligacoes-porta.js'
import { centavosDe } from './porta.js'

/** As três ferramentas de catálogo. Só leitura. */
export function ferramentasDeCatalogo(cat: CatalogoPorta): Ferramenta<never>[] {
  const buscar: Ferramenta<{ consulta: string; limite: number | null }> = {
    nome: 'catalogo_buscar',
    descricao: 'Busca produtos no catálogo da loja por texto (nome, referência, categoria, cor, tamanho, plano). Devolve até N produtos com suas variações (SKUs), preço na tabela deste cliente e saldo. Use antes de citar qualquer produto ou preço.',
    entrada: z.object({
      consulta: z.string().min(1).max(200).describe('O que o cliente procura, em palavras-chave.'),
      limite: z.number().int().min(1).max(8).nullable().describe('Quantos produtos trazer (null = 5).'),
    }),
    async executar(ctx, e) {
      const r = await cat.buscar(ctx, { consulta: e.consulta, limite: e.limite ?? 5 })
      return { ok: true, saida: { itens: r.itens, total: r.itens.length }, centavos: centavosDe(r.itens) }
    },
  }
  const detalhar: Ferramenta<{ produtoId: string }> = {
    nome: 'catalogo_detalhar',
    descricao: 'Detalha um produto já encontrado: descrição completa e todas as variações com preço e saldo.',
    entrada: z.object({ produtoId: z.string().uuid() }),
    async executar(ctx, e) {
      const p = await cat.detalhar(ctx, e.produtoId)
      if (!p) return { ok: false, erro: 'produto não encontrado' }
      return { ok: true, saida: p, centavos: centavosDe(p) }
    },
  }
  const preco: Ferramenta<{ skuIds: string[] }> = {
    nome: 'catalogo_preco_estoque',
    descricao: 'Preço e saldo ATUAIS de variações (SKUs) específicas, na tabela deste cliente. Use para confirmar antes de fechar.',
    entrada: z.object({ skuIds: z.array(z.string().uuid()).min(1).max(20) }),
    async executar(ctx, e) {
      const r = await cat.precoEEstoque(ctx, e.skuIds)
      return { ok: true, saida: { skus: r }, centavos: centavosDe(r) }
    },
  }
  return [buscar, detalhar, preco] as Ferramenta<never>[]
}
