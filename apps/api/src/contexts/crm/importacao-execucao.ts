import { createHash } from 'node:crypto'
import { IMPORTACAO_LOTE, type ContagensImportacao, type CsvLido, type DePara, type ResultadoItem, type TipoImportacao } from '@geracrm/shared'
import { emSavepoint, type Sql } from '../../db/index.js'
import { carregarCatalogos, processarLinha, type Desfecho, type OpcoesImportacao } from './importacao-dominio.js'

/**
 * Simulação e execução em LOTES (raia H1). A simulação não grava no domínio — só `importacao` e `importacao_item`.
 * A execução grava em lotes de `IMPORTACAO_LOTE` linhas, uma transação curta por lote, com um SAVEPOINT por
 * linha: uma linha que o banco recusa vira `rejeitado` com motivo-código e o lote segue.
 */

export const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

export interface ItemParaGravar { linha: number; resultado: ResultadoItem; motivo: string | null; referenciaId: string | null }

export function somar(c: ContagensImportacao, r: ResultadoItem): ContagensImportacao {
  switch (r) {
    case 'criado': return { ...c, criados: c.criados + 1 }
    case 'atualizado': return { ...c, atualizados: c.atualizados + 1 }
    case 'ignorado': return { ...c, ignorados: c.ignorados + 1 }
    case 'rejeitado': return { ...c, rejeitados: c.rejeitados + 1 }
  }
}

/** Grava os itens do lote de uma vez (conflito = a linha já foi gravada numa passada anterior). */
export async function gravarItens(tx: Sql, importacaoId: string, itens: readonly ItemParaGravar[]): Promise<void> {
  if (itens.length === 0) return
  const dados = itens.map((i) => ({
    importacao_id: importacaoId, linha: i.linha, resultado: i.resultado, motivo: i.motivo, referencia_id: i.referenciaId,
  }))
  await tx`
    INSERT INTO importacao_item (tenant_id, importacao_id, linha, resultado, motivo, referencia_id)
    SELECT tenant_atual(), x.importacao_id, x.linha, x.resultado, x.motivo, x.referencia_id::uuid
      FROM jsonb_to_recordset(${JSON.stringify(dados)}::text::jsonb)
           AS x(importacao_id uuid, linha int, resultado text, motivo text, referencia_id text)
    ON CONFLICT (tenant_id, importacao_id, linha) DO NOTHING`
}

export interface ParamsLote {
  readonly tipo: TipoImportacao
  readonly importacaoId: string
  readonly arquivoHash: string
  readonly usuarioId: string | null
  readonly opcoes: OpcoesImportacao
  readonly dePara: DePara
  readonly csv: CsvLido
  readonly agora: Date
}

/** SIMULAÇÃO de um pedaço do arquivo: lê o banco, devolve o previsto e NÃO grava contato/venda/tarefa. */
export async function simularPedaco(
  tx: Sql, p: ParamsLote, linhas: CsvLido['linhas'], vistos: Set<string>, horizonte: Map<string, boolean>,
): Promise<ItemParaGravar[]> {
  const catalogos = await carregarCatalogos(tx)
  const ctx = { modo: 'simular' as const, ...base(p), catalogos, vistos, horizonte }
  const itens: ItemParaGravar[] = []
  for (const l of linhas) {
    const d = await processarLinha(tx, p.tipo, l.campos, l.numero, ctx)
    itens.push({ linha: l.numero, resultado: d.resultado, motivo: d.motivo, referenciaId: null })
  }
  return itens
}

/** Um LOTE da execução, DENTRO da transação do chamador (tenant já escolhido). */
export async function executarPedaco(tx: Sql, p: ParamsLote, linhas: CsvLido['linhas']): Promise<ItemParaGravar[]> {
  const catalogos = await carregarCatalogos(tx)
  const ctx = { modo: 'executar' as const, ...base(p), catalogos, vistos: new Set<string>(), horizonte: new Map<string, boolean>() }
  const itens: ItemParaGravar[] = []
  for (const l of linhas) {
    let d: Desfecho
    try {
      d = await emSavepoint(tx, (sp) => processarLinha(sp, p.tipo, l.campos, l.numero, ctx))
    } catch (erro) {
      // Só erro do Postgres (SQLSTATE) vira rejeição da linha; o resto (bug, rede) sobe e o lote inteiro recomeça.
      if (!/^[0-9A-Z]{5}$/.test((erro as { code?: string } | null)?.code ?? '')) throw erro
      d = { resultado: 'rejeitado', motivo: motivoDeErro(erro), referenciaId: null }
    }
    const item = { linha: l.numero, resultado: d.resultado, motivo: d.motivo, referenciaId: d.referenciaId }
    itens.push(item)
    // Imediato: a próxima linha do lote (duplicada no arquivo) precisa enxergar esta.
    await gravarItens(tx, p.importacaoId, [item])
  }
  return itens
}

/** Código do erro do banco → motivo estável. Nunca a mensagem (pode citar valor da célula). */
function motivoDeErro(erro: unknown): string {
  const codigo = (erro as { code?: string } | null)?.code
  if (codigo === '23514') return 'data_fora_do_horizonte' // venda sem partição para a data
  if (codigo === '23505') return 'conflito_de_duplicidade'
  if (codigo === '23503') return 'referencia_invalida'
  if (codigo === '22001') return 'texto_muito_longo'
  return 'erro_gravacao'
}

const base = (p: ParamsLote) => ({
  importacaoId: p.importacaoId, arquivoHash: p.arquivoHash, usuarioId: p.usuarioId, opcoes: p.opcoes, agora: p.agora,
  colunas: p.csv.colunas, dePara: p.dePara,
})

export { IMPORTACAO_LOTE }
