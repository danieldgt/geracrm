import { describe, it, expect } from 'vitest'
import { playbookPadrao } from '@geracrm/shared'
import {
  adicionarChip, dataCurta, erroDaObservacao, erroDoPrefixo, errosPorCampo, moverItem, numeroOuNulo, slotsLivres, temAlteracao,
  textoDaBarra, textoDaFalhaDoDocumento, textoDaSimulacao, textoDeFalha, tomDaGravidade,
} from './playbook.regras.js'

describe('Playbook — regras da tela', () => {
  it('barra de versão: publicada, vale o da conta, importável', () => {
    expect(textoDaBarra({ escopo: 'numero', publicada: { numero: 7, publicadaEm: '2026-10-12T15:00:00Z', publicadaPor: 'Ada' }, vigente: null, importavel: false }))
      .toMatch(/^Publicada v7 em \d{2}\/10\/2026 por Ada$/)
    expect(textoDaBarra({ escopo: 'numero', publicada: null, vigente: { escopo: 'tenant', numero: 2 }, importavel: false })).toContain('padrão da conta (v2)')
    expect(textoDaBarra({ escopo: 'numero', publicada: null, vigente: null, importavel: true })).toContain('configuração atual')
    expect(dataCurta(null)).toBe('—')
  })

  it('observação de publicação: ≥ 10 caracteres, diz quanto falta', () => {
    expect(erroDaObservacao('curta')).toMatch(/faltam 5/)
    expect(erroDaObservacao('Tirar frete grátis do discurso.')).toBeNull()
  })

  it('erros 422 por campo e por prefixo (item do roteiro)', () => {
    const m = errosPorCampo([{ campo: 'qualificacao[1].pergunta', mensagem: 'curta' }, { campo: 'mensagens.handoff', mensagem: 'prazo' }])
    expect(erroDoPrefixo(m, 'qualificacao[1]')).toBe('curta')
    expect(erroDoPrefixo(m, 'qualificacao[0]')).toBeNull()
    expect(m['mensagens.handoff']).toBe('prazo')
  })

  it('roteiro: mover, slots livres; chips sem duplicar; número ou vazio', () => {
    expect(moverItem(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c'])
    expect(moverItem(['a', 'b'], 0, -1)).toEqual(['a', 'b'])
    expect(slotsLivres([{ slot: 'volume', pergunta: 'x', obrigatorio: false, ativo: true }])).not.toContain('volume')
    expect(adicionarChip(['Frete grátis'], 'frete gratis', 50).erro).toBe('Já está na lista.')
    expect(adicionarChip([], '  pronta   entrega ', 50).lista).toEqual(['pronta entrega'])
    expect(numeroOuNulo('')).toBeNull()
    expect(numeroOuNulo('300')).toBe(300)
  })

  it('alterações não salvas comparam o conteúdo inteiro', () => {
    const a = playbookPadrao()
    expect(temAlteracao(a, structuredClone(a))).toBe(false)
    expect(temAlteracao({ ...a, estilo: { ...a.estilo, maxPerguntas: 1 } }, a)).toBe(true)
  })

  it('falhas nomeadas: 403 só admin; sandbox com ação', () => {
    expect(textoDeFalha(403, 'x')).toBe('Só um administrador pode alterar o playbook.')
    expect(textoDeFalha(422, 'Observação curta')).toBe('Observação curta')
    // the validator text from the document suggestion never reaches the screen
    expect(textoDaFalhaDoDocumento('playbook.sugestao_invalida', 'orientacoes: Invalid input')).toMatch(/^A IA não conseguiu/)
    expect(textoDaFalhaDoDocumento('playbook.documento_grande', 'O documento tem 9 caracteres')).toBe('O documento tem 9 caracteres')
    expect(textoDaSimulacao(422, 'agente.simulacao_limite', 'chegou a 20').reiniciar).toBe(true)
    expect(textoDaSimulacao(409, 'agente.simulacao_em_andamento', undefined).texto).toMatch(/Já há uma simulação/)
    expect(tomDaGravidade('CRITICA')).toBe('erro')
  })
})
