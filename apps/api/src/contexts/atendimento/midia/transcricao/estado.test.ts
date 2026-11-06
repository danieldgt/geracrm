import { describe, it, expect } from 'vitest'
import { estadoDaTranscricao } from './estado.js'

describe('Estado da transcrição do áudio do cliente', () => {
  it('mensagem que não é áudio não entra na conta', () => {
    expect(estadoDaTranscricao('texto', { texto: 'oi' }, true, 3)).toBe('nao_se_aplica')
  })

  it('áudio transcrito está pronto — o agente responde ao texto', () => {
    expect(estadoDaTranscricao('audio', { transcricao: 'quero 10 caixas' }, true, 3)).toBe('pronta')
    expect(estadoDaTranscricao('audio', { transcricao: 'quero 10 caixas' }, false, 3)).toBe('pronta')
  })

  it('com provedor, áudio ainda sem texto espera a transcrição', () => {
    expect(estadoDaTranscricao('audio', {}, true, 3)).toBe('pendente')
    expect(estadoDaTranscricao('audio', { transcricao_tentativas: 2 }, true, 3)).toBe('pendente')
  })

  it('depois das tentativas, desiste', () => {
    expect(estadoDaTranscricao('audio', { transcricao_tentativas: 3 }, true, 3)).toBe('falhou')
  })

  it('sem provedor de transcrição o áudio é falha, não espera eterna', () => {
    expect(estadoDaTranscricao('audio', {}, false, 3)).toBe('falhou')
  })

  it('transcrição vazia (áudio mudo) é falha — o worker não tenta de novo', () => {
    expect(estadoDaTranscricao('audio', { transcricao: '   ' }, true, 3)).toBe('falhou')
  })
})
