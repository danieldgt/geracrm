import { describe, it, expect } from 'vitest'
import { decidirReconciliacao } from './reconciliacao.js'

const c = (id: string, s: Partial<{ ext: boolean; doc: boolean; tel: boolean; conflita: boolean }> = {}) => ({
  contatoId: id,
  porIdentidadeExterna: s.ext ?? false,
  porDocumento: s.doc ?? false,
  porTelefonePrincipal: s.tel ?? false,
  temDocumentoConflitante: s.conflita ?? false,
})

describe('Reconciliação de contato na ingestão', () => {
  it('dado nenhum candidato, então cria', () => {
    expect(decidirReconciliacao([])).toMatchObject({ acao: 'criar', ambiguo: false })
  })

  it('dada identidade externa, então vincula — é o sinal mais forte', () => {
    const d = decidirReconciliacao([c('A', { ext: true }), c('B', { tel: true })])
    expect(d).toMatchObject({ acao: 'vincular', contatoId: 'A', motivo: 'identidade_externa' })
  })

  it('dado documento único, então vincula', () => {
    expect(decidirReconciliacao([c('A', { doc: true })]))
      .toMatchObject({ acao: 'vincular', contatoId: 'A', motivo: 'documento' })
  })

  // ⚠️ O caso que define o desenho: duplicata antes da mesclagem é normal.
  it('dado o mesmo documento em dois contatos, então cria e marca ambíguo', () => {
    const d = decidirReconciliacao([c('A', { doc: true }), c('B', { doc: true })])
    expect(d.acao).toBe('criar')
    expect(d.ambiguo).toBe(true)
    expect(d.detalhe).toContain('mesclagem')
  })

  it('dado telefone principal único, então vincula', () => {
    expect(decidirReconciliacao([c('A', { tel: true })]))
      .toMatchObject({ acao: 'vincular', contatoId: 'A', motivo: 'telefone_principal' })
  })

  it('dado o mesmo telefone principal em dois contatos, então cria e marca ambíguo', () => {
    const d = decidirReconciliacao([c('A', { tel: true }), c('B', { tel: true })])
    expect(d).toMatchObject({ acao: 'criar', ambiguo: true })
  })

  // ⚠️ Mãe e filha na mesma linha. Vincular aqui juntaria o histórico de compra
  // de duas pessoas diferentes.
  it('dado telefone encontrado só como secundário, então cria — pode ser outra pessoa na linha', () => {
    const d = decidirReconciliacao([c('A')])
    expect(d.acao).toBe('criar')
    expect(d.ambiguo).toBe(true)
    expect(d.detalhe).toContain('secundário')
  })

  it('documento vence telefone quando ambos apontam para contatos diferentes', () => {
    const d = decidirReconciliacao([c('A', { doc: true }), c('B', { tel: true })])
    expect(d.contatoId).toBe('A')
  })

  // ⚠️ O LIMIAR novo — o que a ficha da MONICA revelou (566 CNPJs num contato).
  it('⚠️ mesmo telefone mas documento CONFLITANTE, então NÃO funde — é outra empresa', () => {
    const d = decidirReconciliacao([c('A', { tel: true, conflita: true })])
    // CNPJ diferente na mesma linha (loja e dona, matriz e filial). Fundir
    // juntaria históricos de compra de negócios distintos.
    expect(d.acao).toBe('criar')
    expect(d.ambiguo).toBe(false) // decisão confiante: sabemos que é outra
    expect(d.detalhe).toContain('documento diferente')
  })

  it('telefone com um conflitante e um limpo, então vincula ao LIMPO', () => {
    // O conflitante (CNPJ diferente) é descartado; sobra um candidato válido.
    const d = decidirReconciliacao([c('A', { tel: true, conflita: true }), c('B', { tel: true })])
    expect(d).toMatchObject({ acao: 'vincular', contatoId: 'B', motivo: 'telefone_principal' })
  })

  it('telefone sem conflito e sem documento (varejo), então vincula — ADR-019', () => {
    // Cliente de varejo sem CNPJ: o telefone segura, como antes. O limiar só age
    // quando HÁ documento conflitante — não penaliza quem não tem documento.
    const d = decidirReconciliacao([c('A', { tel: true })])
    expect(d).toMatchObject({ acao: 'vincular', contatoId: 'A' })
  })
})
