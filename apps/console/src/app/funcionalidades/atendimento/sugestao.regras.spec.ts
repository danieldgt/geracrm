import { describe, it, expect } from 'vitest'
import { dicaModo, idadeDaSugestao, mensagemErroGerar, motivoSemCopiloto, rotuloModo, seloDaSugestao, tituloDaSugestao } from './sugestao.regras.js'

describe('Painel de sugestão — selo do modo', () => {
  it('nomeia cada modo e o caso sem configuração', () => {
    expect(rotuloModo('assistido')).toBe('Agente assistido')
    expect(rotuloModo('desligado')).toBe('Agente desligado')
    expect(rotuloModo(null)).toBe('Agente não configurado')
    expect(dicaModo('assistido')).toMatch(/sugere/)
  })
})

describe('Painel de sugestão — selo do cartão é o modo em que a sugestão foi gerada', () => {
  it('gerada em assistido mostra "assistido" mesmo com o número já em autônomo, e a dica cita o modo atual', () => {
    const selo = seloDaSugestao({ origem: 'assistido' }, 'autonomo')
    expect(selo.rotulo).toBe('Agente assistido')
    expect(selo.dica).toMatch(/agente autônomo/)
  })
  it('gerada em assistido com o número em assistido: sem nota de mudança', () => {
    expect(seloDaSugestao({ origem: 'assistido' }, 'assistido').dica).not.toMatch(/Agora/)
  })
  it('do copiloto (pedida em sombra) mostra "Copiloto", não "Agente em sombra"', () => {
    expect(seloDaSugestao({ origem: 'copiloto' }, 'sombra').rotulo).toBe('Copiloto')
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
    expect(mensagemErroGerar(409, { erro: 'copiloto.sem_sugestao', motivo: 'orcamento_do_dia', mensagem: 'x' })).toBe('Limite diário de IA deste número atingido.')
    expect(mensagemErroGerar(0, null)).toMatch(/Sem conexão/)
    expect(mensagemErroGerar(500, { erro: 'erro.interno' })).toMatch(/Tente de novo/)
  })
})

describe('Painel de sugestão — quem pediu', () => {
  it('assistido = do agente; copiloto meu = "você pediu"; de outro vendedor = pelo nome', () => {
    expect(tituloDaSugestao({ origem: 'assistido', pedidaPor: null })).toBe('Sugestão do agente')
    expect(tituloDaSugestao({ origem: 'copiloto', pedidaPor: { nome: 'Ana', porMim: true } })).toBe('Sugestão que você pediu')
    expect(tituloDaSugestao({ origem: 'copiloto', pedidaPor: { nome: 'Bia', porMim: false } })).toBe('Sugestão pedida por Bia')
    expect(tituloDaSugestao({ origem: 'copiloto', pedidaPor: { nome: null, porMim: false } })).toBe('Sugestão pedida por outro vendedor')
    expect(tituloDaSugestao({ origem: 'copiloto', pedidaPor: null })).toBe('Sugestão do copiloto')
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
