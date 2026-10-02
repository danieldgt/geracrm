import { createHash, randomUUID } from 'node:crypto'
import type { Sql } from '../../../../db/index.js'
import { TITULO_POLITICAS } from './porta.js'

/**
 * INDEXADOR DA BASE DE CONHECIMENTO — mantém `conhecimento_trecho` (0089) em dia.
 *
 * Um documento vira N trechos de ~300–500 tokens (≈ 1.200–2.000 caracteres):
 * parágrafos (separados por linha em branco) são juntados até o alvo; um
 * parágrafo maior que o teto é partido por frase. Todo trecho começa com o
 * título do documento — é como o modelo sabe de onde o pedaço veio mesmo quando
 * o parágrafo, sozinho, não diz ("Enviamos em até 3 dias" é de "Políticas" ou
 * de "FAQ do atacado"?).
 *
 * Idempotente por hash, trecho a trecho: texto igual na mesma posição → nada é
 * gravado e o embedding (quando houver) continua válido. Texto diferente →
 * regrava e zera `modelo_embedding`, que é como o passo de embedding sabe o que
 * refazer. A cauda que sobrou (documento encolheu) é apagada.
 */

export const ALVO_TRECHO = 1500
export const MAX_TRECHO = 2000

export type ResultadoIndexacao = 'indexado' | 'inalterado' | 'nao_encontrado'

export interface ResultadoSincronizacao {
  readonly documentoId: string | null
  readonly versao: number
  readonly situacao: 'criado' | 'atualizado' | 'inalterado' | 'despublicado' | 'canal_nao_encontrado'
}

function hashDe(texto: string): string {
  return createHash('sha256').update(texto).digest('hex')
}

/** Parte um parágrafo maior que o teto por frases; frase maior que o teto, por espaço. */
function partirPorFrases(paragrafo: string, max: number): string[] {
  const frases = paragrafo.split(/(?<=[.!?;:])\s+/u)
  const pedacos: string[] = []
  let atual = ''
  const empurrar = (): void => { if (atual) pedacos.push(atual); atual = '' }
  for (const frase of frases) {
    if (frase.length > max) {
      empurrar()
      // Última linha de defesa: corta no espaço mais próximo do teto.
      let resto = frase
      while (resto.length > max) {
        const corte = resto.lastIndexOf(' ', max)
        const ponto = corte > max / 2 ? corte : max
        pedacos.push(resto.slice(0, ponto).trim())
        resto = resto.slice(ponto).trim()
      }
      atual = resto
      continue
    }
    if (atual && atual.length + 1 + frase.length > max) empurrar()
    atual = atual ? `${atual} ${frase}` : frase
  }
  empurrar()
  return pedacos
}

/**
 * Fatia o conteúdo em trechos, cada um prefixado pelo título na primeira linha.
 * Pura — testável sem banco.
 */
export function fatiarDocumento(
  titulo: string, conteudo: string,
  limites: { alvo?: number; max?: number } = {},
): string[] {
  const alvo = limites.alvo ?? ALVO_TRECHO
  const max = Math.max(limites.max ?? MAX_TRECHO, alvo)
  const cabecalho = titulo.trim()
  const paragrafos = conteudo.split(/\n\s*\n/u).map((p) => p.trim()).filter(Boolean)

  const pedacos: string[] = []
  for (const p of paragrafos) {
    if (p.length <= max) pedacos.push(p)
    else pedacos.push(...partirPorFrases(p, max))
  }

  const trechos: string[] = []
  let atual = ''
  for (const pedaco of pedacos) {
    if (atual && atual.length + 2 + pedaco.length > alvo) { trechos.push(atual); atual = '' }
    atual = atual ? `${atual}\n\n${pedaco}` : pedaco
  }
  if (atual) trechos.push(atual)
  return trechos.map((t) => `${cabecalho}\n${t}`)
}

/**
 * A coluna `embedding` só existe quando o servidor tem pgvector (0089). Lida
 * UMA vez por processo: o schema muda por migration, que reinicia o processo.
 */
let colunaEmbedding: Promise<boolean> | null = null
export function temColunaEmbeddingConhecimento(tx: Sql): Promise<boolean> {
  if (!colunaEmbedding) {
    colunaEmbedding = tx<{ existe: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM pg_attribute
         WHERE attrelid = 'conhecimento_trecho'::regclass
           AND attname = 'embedding' AND NOT attisdropped) AS existe`
      .then((r) => r[0]?.existe === true)
      .catch((erro: unknown) => { colunaEmbedding = null; throw erro })
  }
  return colunaEmbedding
}

/**
 * Reindexa UM documento: fatia, grava o que mudou, apaga a cauda. Chamado pelas
 * rotas após cada escrita e pelo sincronismo das políticas.
 */
export async function reindexarDocumento(tx: Sql, documentoId: string): Promise<ResultadoIndexacao> {
  const [doc] = await tx<{ titulo: string; conteudo: string }[]>`
    SELECT titulo, conteudo FROM conhecimento_documento
     WHERE tenant_id = tenant_atual() AND id = ${documentoId}`
  if (!doc) return 'nao_encontrado'

  const trechos = fatiarDocumento(doc.titulo, doc.conteudo)
  const temEmbedding = await temColunaEmbeddingConhecimento(tx)
  let mudou = 0

  for (let ordem = 0; ordem < trechos.length; ordem++) {
    const texto = trechos[ordem]!
    const [r] = await tx<{ gravou: boolean }[]>`
      INSERT INTO conhecimento_trecho (tenant_id, id, documento_id, ordem, texto, texto_sem_acento, texto_hash)
      VALUES (tenant_atual(), ${randomUUID()}, ${documentoId}, ${ordem},
              ${texto}, unaccent(lower(${texto})), ${hashDe(texto)})
      ON CONFLICT (tenant_id, documento_id, ordem) DO UPDATE
        SET texto = EXCLUDED.texto,
            texto_sem_acento = EXCLUDED.texto_sem_acento,
            texto_hash = EXCLUDED.texto_hash,
            modelo_embedding = NULL
            ${temEmbedding ? tx`, embedding = NULL` : tx``}
        WHERE conhecimento_trecho.texto_hash IS DISTINCT FROM EXCLUDED.texto_hash
      RETURNING true AS gravou`
    if (r?.gravou) mudou += 1
  }
  const cauda = await tx`
    DELETE FROM conhecimento_trecho
     WHERE tenant_id = tenant_atual() AND documento_id = ${documentoId} AND ordem >= ${trechos.length}`
  mudou += cauda.count

  return mudou > 0 ? 'indexado' : 'inalterado'
}

/**
 * Espelha `agente_config.politicas` no documento 'politicas' do canal.
 *
 * Idempotente: texto igual → nada muda, versão não sobe. Texto diferente →
 * versão +1 e reindexa. Texto vazio → despublica (o dono apagou as políticas;
 * o documento fica guardado e volta quando ele escrever de novo).
 *
 * ⚠️ Roda na MESMA transação do upsert de `agente_config` (rota PUT): a tela
 *    salvou, a base está em dia — nunca um estado em que a coluna diz uma coisa
 *    e o retrieval responde outra.
 */
export async function sincronizarPoliticas(tx: Sql, canalId: string, politicas: string): Promise<ResultadoSincronizacao> {
  const texto = politicas.trim()
  const [canal] = await tx<{ id: string }[]>`
    SELECT id FROM canal_conectado WHERE tenant_id = tenant_atual() AND id = ${canalId}`
  if (!canal) return { documentoId: null, versao: 0, situacao: 'canal_nao_encontrado' }

  const [existente] = await tx<{ id: string; conteudo: string; versao: number; publicado: boolean }[]>`
    SELECT id, conteudo, versao, publicado FROM conhecimento_documento
     WHERE tenant_id = tenant_atual() AND canal_id = ${canalId} AND tipo = 'politicas'`

  if (texto === '') {
    if (!existente || !existente.publicado) {
      return { documentoId: existente?.id ?? null, versao: existente?.versao ?? 0, situacao: 'inalterado' }
    }
    await tx`
      UPDATE conhecimento_documento SET publicado = false, atualizado_em = now()
       WHERE tenant_id = tenant_atual() AND id = ${existente.id}`
    return { documentoId: existente.id, versao: existente.versao, situacao: 'despublicado' }
  }

  if (!existente) {
    const id = randomUUID()
    await tx`
      INSERT INTO conhecimento_documento (tenant_id, id, canal_id, titulo, tipo, conteudo, versao, publicado)
      VALUES (tenant_atual(), ${id}, ${canalId}, ${TITULO_POLITICAS}, 'politicas', ${texto}, 1, true)`
    await reindexarDocumento(tx, id)
    return { documentoId: id, versao: 1, situacao: 'criado' }
  }

  if (existente.conteudo === texto && existente.publicado) {
    return { documentoId: existente.id, versao: existente.versao, situacao: 'inalterado' }
  }

  // Republicar sem mudar o texto não é versão nova; texto novo é.
  const sobeVersao = existente.conteudo !== texto
  const [atualizado] = await tx<{ versao: number }[]>`
    UPDATE conhecimento_documento
       SET conteudo = ${texto},
           versao = ${sobeVersao ? tx`versao + 1` : tx`versao`},
           publicado = true,
           atualizado_em = now()
     WHERE tenant_id = tenant_atual() AND id = ${existente.id}
     RETURNING versao`
  await reindexarDocumento(tx, existente.id)
  return { documentoId: existente.id, versao: atualizado!.versao, situacao: 'atualizado' }
}
