import { describe, expect, it } from 'vitest'
import {
  alterarCanal, alvoDaNotificacao, filtroNotificacaoAtivo, preferenciasAlteradas, queryDeNotificacoes,
  rotuloDoTipo, tituloDaNotificacao, type PreferenciaTipo,
} from './notificacoes.regras.js'

const pref = (tipo: string, canais: Partial<PreferenciaTipo['canais']> = {}, emailDisponivel = false): PreferenciaTipo =>
  ({ tipo, rotulo: tipo, emailDisponivel, canais: { app: true, push: true, email: false, ...canais } })

describe('notificações — regras puras', () => {
  it('query: só o que está preenchido vai para o servidor', () => {
    expect(queryDeNotificacoes({ lida: '', tipo: '' })).toBe('')
    expect(queryDeNotificacoes({ lida: 'nao', tipo: 'sla.estourado' }, 'abc')).toBe('?lida=nao&tipo=sla.estourado&cursor=abc')
    expect(filtroNotificacaoAtivo({ lida: '', tipo: '' })).toBe(false)
    expect(filtroNotificacaoAtivo({ lida: 'sim', tipo: '' })).toBe(true)
  })

  it('abrir leva ao alvo: conversa, tela do assunto ou lugar nenhum', () => {
    expect(alvoDaNotificacao({ tipo: 'mensagem.nova', conversaId: 'c1' })).toEqual({ tipo: 'conversa', conversaId: 'c1' })
    expect(alvoDaNotificacao({ tipo: 'canal.qualidade', conversaId: null })).toEqual({ tipo: 'rota', rota: '/numeros' })
    expect(alvoDaNotificacao({ tipo: 'agenda.lembrete', conversaId: null })).toEqual({ tipo: 'rota', rota: '/agenda' })
    expect(alvoDaNotificacao({ tipo: 'tipo.novo', conversaId: null })).toEqual({ tipo: 'nenhum' })
  })

  it('títulos e rótulos', () => {
    expect(tituloDaNotificacao({ tipo: 'mensagem.nova', titulo: 'Zé' })).toBe('Nova mensagem de Zé')
    expect(tituloDaNotificacao({ tipo: 'sla.estourado', titulo: 'Zé — SLA estourado' })).toBe('Zé — SLA estourado')
    expect(rotuloDoTipo('sla.estourado')).toBe('SLA do atendimento estourado')
    expect(rotuloDoTipo('desconhecido')).toBe('Aviso')
  })

  it('preferências: altera só o canal pedido e envia só o diferença', () => {
    const original = [pref('mensagem.nova'), pref('sla.estourado', { email: true }, true)]
    const atual = alterarCanal(alterarCanal(original, 'mensagem.nova', 'push', false), 'sla.estourado', 'email', false)
    expect(atual[0]!.canais).toEqual({ app: true, push: false, email: false })
    expect(original[0]!.canais.push).toBe(true) // imutável
    expect(preferenciasAlteradas(original, atual)).toEqual([
      { tipo: 'mensagem.nova', canal: 'push', ligado: false },
      { tipo: 'sla.estourado', canal: 'email', ligado: false },
    ])
    expect(preferenciasAlteradas(original, original)).toEqual([])
  })

  it('preferências: e-mail em tipo sem e-mail nunca vai no corpo', () => {
    const original = [pref('mensagem.nova')]
    const atual = alterarCanal(original, 'mensagem.nova', 'email', true)
    expect(preferenciasAlteradas(original, atual)).toEqual([])
  })
})
