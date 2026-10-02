/**
 * PORTA DE EMBEDDING — a perna semântica do retrieval (ADR-026).
 *
 * A porta é definida pelo NOSSO domínio: "transforme estes textos em vetores",
 * dizendo se são consulta ou documento. O fornecedor (Voyage hoje) fica atrás
 * de um adaptador; trocar de fornecedor não toca `busca.ts` nem o indexador.
 *
 * ⚠️ A capacidade `buscaSemantica` é o que o produto DECLARA. Sem chave de API
 * (ou sem pgvector no servidor) a busca fica lexical — FTS + trgm — e a tela
 * pode dizer isso. Degradação visível, nunca quebra (ADR-008).
 */

export type TipoEmbedding = 'consulta' | 'documento'

export interface PortaEmbedding {
  readonly nome: string
  readonly capacidades: { readonly buscaSemantica: boolean }
  /** Dimensão dos vetores — tem de bater com a coluna `vector(1024)` de 0088. */
  readonly dimensoes: number
  /**
   * Um vetor por texto, na mesma ordem. Falha de infraestrutura (rede, chave,
   * limite) sobe como `ErroEmbedding` com código — quem chama decide se degrada
   * para lexical (busca) ou tenta depois (indexador). Nunca chamar com uma
   * transação de banco aberta: é rede externa.
   */
  embutir(textos: readonly string[], tipo: TipoEmbedding): Promise<number[][]>
}

export type CodigoErroEmbedding =
  | 'nao_configurado'
  | 'autenticacao'
  | 'limite_excedido'
  | 'entrada_invalida'
  | 'indisponivel'
  | 'tempo_esgotado'
  | 'resposta_inesperada'

/** Falha TIPIFICADA do fornecedor: a tela e o log ramificam pelo código, nunca pela mensagem. */
export class ErroEmbedding extends Error {
  constructor(readonly codigo: CodigoErroEmbedding, mensagem: string) {
    super(mensagem)
    this.name = 'ErroEmbedding'
  }
}

/**
 * Objeto nulo: declara a capacidade desligada. Chamar `embutir` nele é defeito
 * de programação (quem chama devia ter olhado `capacidades`), então estoura.
 */
export const EmbeddingIndisponivel: PortaEmbedding = {
  nome: 'indisponivel',
  capacidades: { buscaSemantica: false },
  dimensoes: 0,
  async embutir() {
    throw new ErroEmbedding('nao_configurado', 'Busca semântica desligada: sem provedor de embedding.')
  },
}

export const MODELO_VOYAGE = 'voyage-4'
export const DIMENSOES_VOYAGE = 1024
const URL_VOYAGE = 'https://api.voyageai.com/v1/embeddings'
const TIMEOUT_PADRAO_MS = 15_000
/** Teto do fornecedor por requisição; o chamador lota acima disso. */
const MAX_TEXTOS_POR_CHAMADA = 128

type Fetch = typeof fetch

export interface OpcoesVoyage {
  apiKey: string
  /** Injetável para teste — NUNCA se chama a rede em teste automatizado. */
  fetch?: Fetch
  timeoutMs?: number
  modelo?: string
}

interface RespostaVoyage {
  data?: { embedding?: unknown; index?: number }[]
}

/**
 * Adaptador Voyage AI (`voyage-4`, 1024 dims). Só conhece o formato do
 * fornecedor; nada do domínio vaza para cá e nada daqui vaza para fora além
 * de `number[][]` e `ErroEmbedding`.
 */
export function criarEmbeddingVoyage(opcoes: OpcoesVoyage): PortaEmbedding {
  const chamar: Fetch = opcoes.fetch ?? fetch
  const timeoutMs = opcoes.timeoutMs ?? TIMEOUT_PADRAO_MS
  const modelo = opcoes.modelo ?? MODELO_VOYAGE

  return {
    nome: `voyage:${modelo}`,
    capacidades: { buscaSemantica: true },
    dimensoes: DIMENSOES_VOYAGE,

    async embutir(textos, tipo) {
      if (textos.length === 0) return []
      if (textos.length > MAX_TEXTOS_POR_CHAMADA) {
        throw new ErroEmbedding('entrada_invalida', `No máximo ${MAX_TEXTOS_POR_CHAMADA} textos por chamada.`)
      }

      let resposta: Response
      try {
        resposta = await chamar(URL_VOYAGE, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${opcoes.apiKey}`,
          },
          body: JSON.stringify({
            input: textos,
            model: modelo,
            input_type: tipo === 'consulta' ? 'query' : 'document',
            output_dimension: DIMENSOES_VOYAGE,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (erro) {
        const nome = erro instanceof Error ? erro.name : ''
        if (nome === 'TimeoutError' || nome === 'AbortError') {
          throw new ErroEmbedding('tempo_esgotado', `Voyage não respondeu em ${timeoutMs}ms.`)
        }
        throw new ErroEmbedding('indisponivel', `Voyage inacessível: ${erro instanceof Error ? erro.message : String(erro)}`)
      }

      if (!resposta.ok) throw mapearStatus(resposta.status)

      let corpo: RespostaVoyage
      try {
        corpo = (await resposta.json()) as RespostaVoyage
      } catch {
        throw new ErroEmbedding('resposta_inesperada', 'Voyage respondeu algo que não é JSON.')
      }

      const dados = corpo.data
      if (!Array.isArray(dados) || dados.length !== textos.length) {
        throw new ErroEmbedding('resposta_inesperada',
          `Voyage devolveu ${Array.isArray(dados) ? dados.length : 0} vetor(es) para ${textos.length} texto(s).`)
      }
      // ⚠️ Ordena por `index`: o contrato do fornecedor não promete a ordem da entrada.
      const vetores: (number[] | undefined)[] = Array.from({ length: textos.length })
      for (let i = 0; i < dados.length; i++) {
        const item = dados[i]!
        const posicao = typeof item.index === 'number' ? item.index : i
        const v = item.embedding
        if (!Array.isArray(v) || v.length !== DIMENSOES_VOYAGE || !v.every((x) => typeof x === 'number')) {
          throw new ErroEmbedding('resposta_inesperada', `Vetor ${posicao} não tem ${DIMENSOES_VOYAGE} dimensões.`)
        }
        vetores[posicao] = v as number[]
      }
      if (!vetores.every((v): v is number[] => v !== undefined)) {
        throw new ErroEmbedding('resposta_inesperada', 'Voyage devolveu índices fora da faixa.')
      }
      return vetores
    },
  }
}

function mapearStatus(status: number): ErroEmbedding {
  if (status === 401 || status === 403) return new ErroEmbedding('autenticacao', 'Chave da Voyage recusada.')
  if (status === 429) return new ErroEmbedding('limite_excedido', 'Voyage: limite de requisições atingido.')
  if (status === 400 || status === 422) return new ErroEmbedding('entrada_invalida', `Voyage recusou a entrada (${status}).`)
  if (status >= 500) return new ErroEmbedding('indisponivel', `Voyage indisponível (${status}).`)
  return new ErroEmbedding('resposta_inesperada', `Voyage respondeu ${status}.`)
}

/**
 * Fábrica pelo ambiente: com `VOYAGE_API_KEY`, Voyage; sem, o objeto nulo. É a
 * única leitura de env deste contexto, e acontece aqui — não no import — para
 * que teste e worker possam decidir depois de carregar o `.env`.
 */
export function embeddingDoAmbiente(env: NodeJS.ProcessEnv = process.env): PortaEmbedding {
  const apiKey = env.VOYAGE_API_KEY?.trim()
  if (!apiKey) return EmbeddingIndisponivel
  return criarEmbeddingVoyage({ apiKey })
}
