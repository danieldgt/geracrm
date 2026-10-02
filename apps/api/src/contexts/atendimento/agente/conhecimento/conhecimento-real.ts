import { comTenantServico } from '../../../../db/index.js'
import { embutirConsulta } from '../../../catalogo/busca.js'
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

export function criarConhecimentoReal(opcoes: { embedding?: PortaEmbedding } = {}): ConhecimentoPorta {
  let porta: PortaEmbedding | null = opcoes.embedding ?? null
  const embedding = (): PortaEmbedding => (porta ??= embeddingDoAmbiente())

  return {
    async buscar(ctx, pergunta) {
      const e = embedding()
      const vetor = e.capacidades.buscaSemantica ? (await embutirConsulta(e, pergunta)).vetor : null
      const r = await comTenantServico(ctx.tenantId, (tx) => buscarConhecimento(tx, {
        pergunta, canalId: ctx.canalId, limite: TRECHOS_PARA_O_MODELO,
        ...(vetor ? { vetorConsulta: vetor } : {}),
      }))
      return { trechos: r.trechos.map((t) => ({ texto: t.texto, fonte: `${t.titulo} v${t.versao}` })) }
    },
  }
}

/** A instância padrão — provedor de embedding lido do ambiente na primeira busca. */
export const conhecimentoReal: ConhecimentoPorta = criarConhecimentoReal()
