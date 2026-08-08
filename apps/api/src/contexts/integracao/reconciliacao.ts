/**
 * Deciding whether an incoming record IS an existing contact.
 *
 * Kept pure on purpose: this is the hardest rule in the ingestion and the one
 * that must be testable without a database. Getting it wrong merges two real
 * customers into one — and unmerging is worse than never merging.
 *
 * ⚠️ Retail changed the weights here (ADR-019). Most customers have no
 * document at all, so the normalised phone carries the load — and the phone is
 * a weaker key than it looks: mother and daughter share a line, so do a couple,
 * so does a shop and its owner.
 */

export type MotivoVinculo =
  | 'identidade_externa'   // strongest: the ERP itself says it is the same record
  | 'documento'            // strong: CNPJ/CPF match
  | 'telefone_principal'   // good: an unambiguous primary phone
  | 'nenhum'               // no match — create

export interface Candidato {
  readonly contatoId: string
  /** Which signals matched. */
  readonly porIdentidadeExterna: boolean
  readonly porDocumento: boolean
  readonly porTelefonePrincipal: boolean
}

export interface Decisao {
  readonly acao: 'vincular' | 'criar'
  readonly contatoId?: string | undefined
  readonly motivo: MotivoVinculo
  /**
   * ⚠️ Ambiguity is recorded, never resolved by guessing. When more than one
   * contact answers to the same signal, we create a new record AND flag it —
   * a duplicate is a chore, a wrong merge is a customer reading someone else's
   * purchase history.
   */
  readonly ambiguo: boolean
  readonly detalhe?: string | undefined
}

export function decidirReconciliacao(candidatos: readonly Candidato[]): Decisao {
  if (candidatos.length === 0) {
    return { acao: 'criar', motivo: 'nenhum', ambiguo: false }
  }

  // 1. External identity — the ERP telling us "this is record 4471".
  // It cannot be ambiguous: the pair (system, external id) is unique by design.
  const porId = candidatos.filter((c) => c.porIdentidadeExterna)
  if (porId.length === 1) {
    return { acao: 'vincular', contatoId: porId[0]!.contatoId, motivo: 'identidade_externa', ambiguo: false }
  }
  if (porId.length > 1) {
    // Should be impossible given the unique key. If it happens, the data is
    // already corrupt and guessing would hide it.
    return {
      acao: 'criar', motivo: 'nenhum', ambiguo: true,
      detalhe: `${porId.length} contatos com a mesma identidade externa — chave única violada em algum ponto`,
    }
  }

  // 2. Document.
  const porDoc = candidatos.filter((c) => c.porDocumento)
  if (porDoc.length === 1) {
    return { acao: 'vincular', contatoId: porDoc[0]!.contatoId, motivo: 'documento', ambiguo: false }
  }
  if (porDoc.length > 1) {
    // ⚠️ Same CNPJ on several contacts is normal before merging (0008 allows it
    // on purpose). Picking one would attach the sale to an arbitrary half.
    return {
      acao: 'criar', motivo: 'nenhum', ambiguo: true,
      detalhe: `${porDoc.length} contatos com o mesmo documento — pendente de mesclagem`,
    }
  }

  // 3. Primary phone — the retail workhorse.
  const porTel = candidatos.filter((c) => c.porTelefonePrincipal)
  if (porTel.length === 1) {
    return { acao: 'vincular', contatoId: porTel[0]!.contatoId, motivo: 'telefone_principal', ambiguo: false }
  }
  if (porTel.length > 1) {
    return {
      acao: 'criar', motivo: 'nenhum', ambiguo: true,
      detalhe: `${porTel.length} contatos com o mesmo telefone principal`,
    }
  }

  // 4. Matched only on a NON-primary phone. ⚠️ Deliberately not enough:
  // this is the mother-and-daughter case. Linking here attaches one person's
  // purchases to another's history.
  return {
    acao: 'criar', motivo: 'nenhum', ambiguo: true,
    detalhe: 'telefone encontrado apenas como secundário — pode ser outra pessoa na mesma linha',
  }
}
