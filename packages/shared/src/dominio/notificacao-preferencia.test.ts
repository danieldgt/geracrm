import { describe, it, expect } from 'vitest'
import { TIPOS_NOTIFICACAO, padraoDoTipo, resolverCanais, validarPreferencias } from './notificacao-preferencia.js'

describe('preferências de notificação', () => {
  it('sem linha: app e push ligados; e-mail só no SLA estourado', () => {
    expect(padraoDoTipo('mensagem.nova')).toEqual({ app: true, push: true, email: false })
    expect(padraoDoTipo('sla.estourado').email).toBe(true)
    expect(padraoDoTipo('campanha.pausada')).toEqual({ app: true, push: true, email: false })
    expect(TIPOS_NOTIFICACAO.some((t) => t.codigo === 'conversa.mencao')).toBe(false)
  })
  it('a linha do usuário vence o padrão, só no tipo e canal dela', () => {
    const c = resolverCanais('mensagem.nova', [
      { tipo: 'mensagem.nova', canal: 'app', ligado: false },
      { tipo: 'fila.nova', canal: 'push', ligado: false },
    ])
    expect(c).toEqual({ app: false, push: true, email: false })
  })
  it('e-mail em tipo sem e-mail nunca liga', () => {
    expect(resolverCanais('mensagem.nova', [{ tipo: 'mensagem.nova', canal: 'email', ligado: true }]).email).toBe(false)
  })
  it('valida o corpo com erro tipificado', () => {
    expect(validarPreferencias({ itens: [{ tipo: 'x', canal: 'app', ligado: true }] })).toMatchObject({ ok: false, erro: 'preferencia.tipo_invalido' })
    expect(validarPreferencias({ itens: [{ tipo: 'fila.nova', canal: 'sms', ligado: true }] })).toMatchObject({ erro: 'preferencia.canal_invalido' })
    expect(validarPreferencias({ itens: [{ tipo: 'fila.nova', canal: 'email', ligado: true }] })).toMatchObject({ erro: 'preferencia.email_indisponivel' })
    expect(validarPreferencias({ itens: [{ tipo: 'fila.nova', canal: 'app', ligado: 'sim' }] })).toMatchObject({ erro: 'preferencia.corpo_invalido' })
    expect(validarPreferencias({ itens: [{ tipo: 'fila.nova', canal: 'app', ligado: true }, { tipo: 'fila.nova', canal: 'app', ligado: false }] })).toMatchObject({ erro: 'preferencia.duplicada' })
    expect(validarPreferencias({ itens: [{ tipo: 'sla.estourado', canal: 'email', ligado: false }] })).toMatchObject({ ok: true })
  })
})
