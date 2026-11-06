import { describe, it, expect } from 'vitest'
import { ESPERA_TRANSCRICAO_MS, vistaTranscricao } from './transcricao.regras.js'

const agora = Date.parse('2026-11-05T12:00:00Z')
const audio = (conteudo: unknown, minutosAtras = 1, direcao: 'entrante' | 'saliente' = 'entrante') => ({
  tipo: 'audio', direcao, conteudo, criadoEm: new Date(agora - minutosAtras * 60_000).toISOString(),
})

describe('Transcrição embaixo do áudio', () => {
  it('mostra o texto transcrito', () => {
    expect(vistaTranscricao(audio({ audio: 'k', transcricao: ' quero 10 caixas ' }), agora))
      .toEqual({ tipo: 'texto', texto: 'quero 10 caixas' })
  })

  it('enquanto o worker trabalha, avisa que está transcrevendo', () => {
    expect(vistaTranscricao(audio({ audio: 'k' }, 1), agora)).toEqual({ tipo: 'transcrevendo' })
  })

  it('passada a janela sem texto (ex.: sem provedor), não promete nada', () => {
    expect(vistaTranscricao(audio({ audio: 'k' }, ESPERA_TRANSCRICAO_MS / 60_000 + 1), agora)).toBeNull()
  })

  it('depois das tentativas, ou com áudio mudo, diz que não deu', () => {
    expect(vistaTranscricao(audio({ audio: 'k', transcricao_tentativas: 3 }), agora)).toEqual({ tipo: 'falhou' })
    expect(vistaTranscricao(audio({ audio: 'k', transcricao: '' }), agora)).toEqual({ tipo: 'falhou' })
  })

  it('áudio que nós enviamos e mensagens que não são áudio ficam como estão', () => {
    expect(vistaTranscricao(audio({ audio: 'k' }, 1, 'saliente'), agora)).toBeNull()
    expect(vistaTranscricao({ ...audio({ texto: 'oi' }), tipo: 'texto' }, agora)).toBeNull()
  })
})
