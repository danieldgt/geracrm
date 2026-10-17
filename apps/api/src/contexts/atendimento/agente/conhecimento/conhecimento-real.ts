import { comTenantServico, sql } from '../../../../db/index.js'
import { embutirConsulta } from '../../../catalogo/busca.js'
import { cacheConsultaPadrao } from '../../../catalogo/cache-consulta.js'
import { embeddingDoAmbiente, type PortaEmbedding } from '../../../catalogo/porta-embedding.js'
import type { ConhecimentoPorta } from '../ferramentas/ligacoes-porta.js'
import { buscarConhecimento } from './busca.js'

/**
 * A base de conhecimento REAL atrás da porta do vendedor (`ConhecimentoPorta`).
 *
 * Substitui `ferramentas/conhecimento-politicas.ts` (parágrafos do campo de
 * texto): agora os trechos vêm de `conhecimento_trecho`, por FTS + trgm (+
 * vetor quando existe), e cada um cita "Título vN" — documento e versão.
 *
 * ⚠️ O embedding da pergunta é calculado ANTES de abrir a transação: é rede
 *    externa. Sem provedor (ou com ele fora), a busca é lexical e segue — a
 *    degradação é visível no `fontes` da busca, nunca um erro para o modelo.
 */

const TRECHOS_PARA_O_MODELO = 3

/**
 * DE QUAL documento e versão vieram os trechos (P9). A saída da ferramenta é
 * gravada em `agente_decisao.ferramentas[].saida`; é por aqui que "Frete v3"
 * numa decisão abre o texto exato da v3 (`GET …/conhecimento/:id/versoes/3`) —
 * o título sozinho não identifica (muda, e dois documentos podem ter o mesmo).
 *
 * ⚠️ Vai PRIMEIRO no objeto: a saída gravada é cortada em 4.000 caracteres
 *    (`resumir` em vendedor.ts) e a citação não pode ser o que se perde.
 */
export interface CitacaoConhecimento {
  readonly documentoId: string
  readonly versao: number
  readonly titulo: string
}

export function citacoesDe(trechos: readonly { documentoId: string; versao: number; titulo: string }[]): CitacaoConhecimento[] {
  const vistas = new Set<string>()
  const saida: CitacaoConhecimento[] = []
  for (const t of trechos) {
    const k = `${t.documentoId}:${t.versao}`
    if (vistas.has(k)) continue
    vistas.add(k)
    saida.push({ documentoId: t.documentoId, versao: t.versao, titulo: t.titulo })
  }
  return saida
}

export function criarConhecimentoReal(opcoes: { embedding?: PortaEmbedding } = {}): ConhecimentoPorta {
  let porta: PortaEmbedding | null = opcoes.embedding ?? null
  const embedding = (): PortaEmbedding => (porta ??= embeddingDoAmbiente())

  return {
    async buscar(ctx, pergunta) {
      const e = embedding()
      const emb = e.capacidades.buscaSemantica ? await embutirConsulta(e, pergunta, { cache: cacheConsultaPadrao(sql) }) : null
      const r = await comTenantServico(ctx.tenantId, (tx) => buscarConhecimento(tx, {
        pergunta, canalId: ctx.canalId, limite: TRECHOS_PARA_O_MODELO,
        ...(emb?.vetor ? { vetorConsulta: emb.vetor, modeloEmbedding: emb.modelo } : {}),
      }))
      return { citacoes: citacoesDe(r.trechos), trechos: r.trechos.map((t) => ({ texto: t.texto, fonte: `${t.titulo} v${t.versao}` })) }
    },
  }
}

/** A instância padrão — provedor de embedding lido do ambiente na primeira busca. */
export const conhecimentoReal: ConhecimentoPorta = criarConhecimentoReal()
