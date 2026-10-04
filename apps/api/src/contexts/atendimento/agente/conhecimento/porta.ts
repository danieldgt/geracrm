/**
 * BASE DE CONHECIMENTO — o contrato (raia R3, ADR-023/026).
 *
 * O que o resto do agente (e o console) sabe sobre conhecimento está aqui:
 * tipos de documento, o que uma busca devolve e o que ela aceita. Como o
 * trecho é achado (FTS, trgm, vetor) é detalhe de `busca.ts`; como ele é
 * fatiado é detalhe de `indexador.ts`.
 *
 * ⚠️ Todo trecho devolvido carrega documento + versão. É a regra "o agente só
 *    diz o que o banco sabe" aplicada à política: a resposta do robô aponta
 *    para o texto exato, na versão exata, que o dono escreveu.
 */

export const TIPOS_DOCUMENTO = ['politicas', 'faq', 'frete', 'pagamento', 'troca', 'produto', 'outro'] as const
export type TipoDocumento = (typeof TIPOS_DOCUMENTO)[number]

/** Título fixo do documento que espelha `agente_config.politicas` de um canal. */
export const TITULO_POLITICAS = 'Políticas da loja'

export type FonteConhecimento = 'lexical' | 'trgm' | 'semantica'

export interface OpcoesBuscaConhecimento {
  readonly pergunta: string
  /**
   * Canal da conversa: entram documentos do canal E os globais (`canal_id`
   * NULL). Sem canal (console "testar a base"), entram todos os publicados.
   */
  readonly canalId?: string | undefined
  /** Padrão 3, teto 10 — é o "punhado" que vai para o modelo, não paginação. */
  readonly limite?: number | undefined
  /** Embedding da pergunta já calculado FORA da transação (rede externa). */
  readonly vetorConsulta?: readonly number[] | undefined
  /** Provedor que gerou o vetor: a perna semântica só compara com trechos embutidos por ele. */
  readonly modeloEmbedding?: string | undefined
}

export interface TrechoEncontrado {
  readonly texto: string
  readonly documentoId: string
  readonly titulo: string
  readonly tipo: TipoDocumento
  readonly versao: number
  /** Pontuação RRF — ordena e diz "quão perto". */
  readonly score: number
  readonly fontes: readonly FonteConhecimento[]
}

export interface ResultadoBuscaConhecimento {
  readonly trechos: readonly TrechoEncontrado[]
  /** Quais pernas rodaram — a tela diz se a semântica estava ligada. */
  readonly fontes: readonly FonteConhecimento[]
}
