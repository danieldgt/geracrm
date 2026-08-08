import { describe, it, expect } from 'vitest'
import { decidirReconciliacao } from './reconciliacao.js'

const c = (id: string, s: Partial<{ ext: boolean; doc: boolean; tel: boolean }> = {}) => ({
  contatoId: id,
  porIdentidadeExterna: s.ext ?? false,
  porDocumento: s.doc ?? false,
  porTelefonePrincipal: s.tel ?? false,
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
})
