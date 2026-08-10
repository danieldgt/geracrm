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
  /**
   * ⚠️ O candidato tem documento PRÓPRIO diferente do que está entrando. Mesmo
   * telefone + documento conflitante = OUTRA entidade (loja e dona, matriz e
   * filial, dois lojistas compartilhando uma linha). Sem este limiar, 566 CNPJs
   * distintos no mesmo telefone viram um contato só — foi o que a ficha revelou.
   */
  readonly temDocumentoConflitante: boolean
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

  // 3. Primary phone — the retail workhorse, but the WEAKEST key.
  const porTel = candidatos.filter((c) => c.porTelefonePrincipal)
  if (porTel.length > 0) {
    // ⚠️ O LIMIAR: telefone só funde quem NÃO tem documento conflitante. CNPJ
    //    diferente na mesma linha é outra empresa — fundir juntaria históricos
    //    de compra de negócios distintos, e desfazer é pior que nunca ter feito.
    const semConflito = porTel.filter((c) => !c.temDocumentoConflitante)

    if (semConflito.length === 1) {
      return { acao: 'vincular', contatoId: semConflito[0]!.contatoId, motivo: 'telefone_principal', ambiguo: false }
    }
    if (semConflito.length === 0) {
      // Todos os que casam por telefone têm documento diferente → outra entidade.
      // Decisão CONFIANTE de criar (não ambígua): sabemos que é outra empresa.
      return {
        acao: 'criar', motivo: 'nenhum', ambiguo: false,
        detalhe: 'mesmo telefone, documento diferente — outra empresa na mesma linha',
      }
    }
    // Mais de um sem conflito no mesmo telefone: aí sim é ambíguo (mãe e filha,
    // casal), e criar-e-sinalizar é mais seguro que escolher um.
    return {
      acao: 'criar', motivo: 'nenhum', ambiguo: true,
      detalhe: `${semConflito.length} contatos com o mesmo telefone principal, sem documento que desempate`,
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
