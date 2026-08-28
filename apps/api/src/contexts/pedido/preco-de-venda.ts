import type { PerfilPreco } from '@geracrm/shared'
import type { Sql } from '../../db/index.js'

/**
 * QUAL TABELA DE PREÇO VALE PARA O PERFIL — a regra, num lugar só.
 *
 * ⚠️ Esta regra já esteve escrita TRÊS vezes em SQL: duas em `rotas-pedido.ts`
 * (a busca rápida do painel e a busca paginada da tela robusta) e a terceira
 * estava para nascer no agente. Não é duplicação cosmética: cada cópia decide
 * quanto o cliente paga, e a que envelhecer sozinha cota um número diferente da
 * outra na mesma loja, no mesmo dia. O sintoma aparece no WhatsApp do cliente,
 * não no CI.
 *
 * ⚠️ **O que a regra protege**, em ordem de estrago:
 *
 * 1. **Tabela de CUSTO nunca cota** (0074). Antes disso a escolha era por nome,
 *    e bastava existir uma "Custo Varejo" para o produto mostrar a margem da
 *    loja a um cliente. Das 24 tabelas do ERP de produção, 3 das 6 ativas são de
 *    custo.
 * 2. **Tabela desativada no ERP nunca cota** (0074) — preço velho é preço errado.
 * 3. **DECLARADO ganha do nome** (0077), e a exclusividade é ABSOLUTA: havendo
 *    tabela declarada para o perfil, a que casaria por nome deixa de ser
 *    candidata. Não é desempate por ordenação — se fosse, um `padrao = true` no
 *    ERP viraria o jogo sem ninguém pedir.
 * 4. **Declarar um perfil não quebra o outro**: o palpite por nome continua
 *    valendo para o perfil que ninguém declarou. É degradação, não erro.
 *
 * O comportamento está preso pelos testes de `preco-perfil.test.ts` (pela rota)
 * e `preco-de-venda.test.ts` (pela função). Os dois provam a MESMA regra de
 * propósito: é assim que se descobre que as duas portas divergiram.
 */

/**
 * O preço de um SKU como resultado NOMEADO, não `number | null`.
 *
 * ⚠️ `null` obrigava quem chama a adivinhar entre três situações diferentes, com
 * ações corretivas diferentes (PED-08): SKU que não existe é erro de quem pediu;
 * SKU sem preço é tabela a configurar no ERP; cotado é seguir em frente. O
 * agente precisa dessa distinção para dizer "não achei esse produto" em vez de
 * montar uma prévia com um buraco silencioso.
 */
export type PrecoDeVenda =
  | { readonly situacao: 'cotado'; readonly centavos: number }
  /** O SKU existe e está ativo, mas nenhuma tabela do perfil tem preço dele. */
  | { readonly situacao: 'sem_preco' }
  /** Não existe, não está ativo, ou é de outro tenant (a RLS não o entrega). */
  | { readonly situacao: 'sku_desconhecido' }

/**
 * ⚠️ Teto de segurança para a consulta em lote. Não é paginação — a entrada é
 * uma lista de ids que o DOMÍNIO montou (os itens de um pedido, os SKUs que o
 * agente reconheceu), nunca um filtro do cliente. O teto existe para que um
 * chamador com defeito não peça a base inteira de uma vez.
 */
const MAX_SKUS_POR_CONSULTA = 200

/**
 * O subselect escalar do preço, para embutir em consulta de catálogo.
 *
 * ⚠️ Existe além de `precosDeVenda()` porque o catálogo precisa do preço DENTRO
 * da mesma consulta — para filtrar por faixa de preço e ordenar sem trazer a
 * base para a aplicação. Buscar depois, em segunda viagem, quebraria o filtro
 * `precoMin/precoMax` da tela robusta.
 *
 * `aliasSku` é o apelido da tabela `sku` na consulta de fora (`'s'`). Vem do
 * nosso código, nunca do cliente; o driver ainda o escapa como identificador.
 */
export function fragmentoPrecoDeVenda(sql: Sql, aliasSku: string, perfil: PerfilPreco) {
  const porNome = `%${perfil}%`
  return sql`(
    SELECT sp.preco_centavos
      FROM sku_preco sp
      JOIN tabela_preco tp ON tp.tenant_id = sp.tenant_id AND tp.id_externo = sp.tabela_externa
     WHERE sp.tenant_id = ${sql(aliasSku)}.tenant_id AND sp.sku_id = ${sql(aliasSku)}.id
       -- (1) e (2): nunca custo, nunca desativada.
       AND tp.proposito = 'venda' AND tp.ativa
       AND (tp.perfil = ${perfil}
            -- (3): o ramo do nome só existe enquanto NINGUÉM declarou este
            --      perfil. Com declaração, o NOT EXISTS zera este lado inteiro.
            OR (tp.perfil IS NULL
                AND NOT EXISTS (SELECT 1 FROM tabela_preco d
                                 WHERE d.tenant_id = sp.tenant_id
                                   AND d.sistema = tp.sistema
                                   AND d.perfil = ${perfil})
                AND tp.descricao ILIKE ${porNome}
                -- ⚠️ Ruído conhecido do ERP: tabelas de CF-e e de teste têm
                --    "varejo" no nome e não praticam o preço de varejo.
                AND tp.descricao NOT ILIKE '%cfe%'
                AND tp.descricao NOT ILIKE '%teste%'))
     ORDER BY tp.padrao DESC, tp.id_externo
     LIMIT 1)`
}

/**
 * O preço de venda de SKUs já conhecidos, para quem NÃO está montando uma
 * consulta de catálogo — a montagem de pedido e, na sequência, a prévia do
 * agente.
 *
 * ⚠️ Devolve uma entrada para CADA id pedido, inclusive os que não existem. Um
 * mapa que só traz o que achou faz o chamador confundir "não existe" com "sem
 * preço" pela ausência da chave — exatamente a distinção que `PrecoDeVenda`
 * existe para preservar.
 *
 * ⚠️ Roda sob a transação de tenant de quem chama (`comTenant`/`comTenantServico`):
 * a RLS é quem garante que id de outra empresa volte como `sku_desconhecido`, e
 * não com o preço dela.
 */
export async function precosDeVenda(
  sql: Sql, skuIds: readonly string[], perfil: PerfilPreco,
): Promise<ReadonlyMap<string, PrecoDeVenda>> {
  const pedidos = [...new Set(skuIds)]
  if (pedidos.length === 0) return new Map()
  if (pedidos.length > MAX_SKUS_POR_CONSULTA) {
    // Defeito de programação, não falha de negócio: quem chama montou a lista.
    throw new Error(`precosDeVenda: ${pedidos.length} SKUs acima do teto de ${MAX_SKUS_POR_CONSULTA}`)
  }

  const linhas = await sql<{ id: string; preco_centavos: string | null }[]>`
    SELECT s.id, ${fragmentoPrecoDeVenda(sql, 's', perfil)}::text AS preco_centavos
      FROM sku s
     WHERE s.tenant_id = tenant_atual()
       AND s.id = ANY(${pedidos}::uuid[])
       AND s.ativo`

  const achados = new Map(linhas.map((l) => [l.id, l.preco_centavos] as const))
  // ⚠️ A anotação não é decorativa: sem ela o TS infere o tipo do mapa pela
  //    PRIMEIRA entrada e recusa as outras duas situações.
  const entradas: [string, PrecoDeVenda][] = pedidos.map((id) => {
    if (!achados.has(id)) return [id, { situacao: 'sku_desconhecido' }]
    const preco = achados.get(id)
    return preco === null || preco === undefined
      ? [id, { situacao: 'sem_preco' }]
      // ⚠️ Dinheiro em centavos INTEIROS. O `::text` na consulta é o que impede o
      //    driver de devolver `numeric` como float e perder centavo no caminho.
      : [id, { situacao: 'cotado', centavos: Number(preco) }]
  })
  return new Map(entradas)
}
