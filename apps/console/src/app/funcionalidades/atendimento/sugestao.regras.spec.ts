import { describe, it, expect } from 'vitest'
import { dicaModo, idadeDaSugestao, mensagemErroGerar, motivoSemCopiloto, rotuloModo } from './sugestao.regras.js'

describe('Painel de sugestão — selo do modo', () => {
  it('nomeia cada modo e o caso sem configuração', () => {
    expect(rotuloModo('assistido')).toBe('Agente assistido')
    expect(rotuloModo('desligado')).toBe('Agente desligado')
    expect(rotuloModo(null)).toBe('Agente não configurado')
    expect(dicaModo('assistido')).toMatch(/sugere/)
  })
})

describe('Painel de sugestão — copiloto indisponível', () => {
  it('desligado mostra o texto combinado no lugar do botão', () => {
    expect(motivoSemCopiloto({ copilotoDisponivel: false, motivoIndisponivel: 'agente.desligado' })).toBe('Agente desligado — sugestão indisponível')
    expect(motivoSemCopiloto({ copilotoDisponivel: false, motivoIndisponivel: 'agente.sem_configuracao' })).toMatch(/não configurado/)
    expect(motivoSemCopiloto({ copilotoDisponivel: true, motivoIndisponivel: null })).toBeNull()
  })
  it('erros tipados do gerar viram frase com ação; sem conexão é nomeado', () => {
    expect(mensagemErroGerar(502, { erro: 'copiloto.indisponivel' })).toMatch(/não respondeu a tempo/)
    expect(mensagemErroGerar(409, { erro: 'copiloto.sem_sugestao', mensagem: 'Teto atingido.' })).toBe('Teto atingido.')
    expect(mensagemErroGerar(0, null)).toMatch(/Sem conexão/)
    expect(mensagemErroGerar(500, { erro: 'erro.interno' })).toMatch(/Tente de novo/)
  })
})

describe('Painel de sugestão — idade', () => {
  it('agora, minutos e horas', () => {
    const agora = new Date('2026-10-17T12:00:00Z')
    expect(idadeDaSugestao('2026-10-17T11:59:40Z', agora)).toBe('agora')
    expect(idadeDaSugestao('2026-10-17T11:57:00Z', agora)).toBe('há 3 min')
    expect(idadeDaSugestao('2026-10-17T09:30:00Z', agora)).toBe('há 2 h')
  })
})
