import { describe, it, expect } from 'vitest'
import {
  adicionarFeriado, badgeStatusTemplate, erroDaApi, feriadoDeData, removerFeriado, rotuloFeriado, rotuloSuspensao, validarAtivas,
} from './ativas.regras.js'

describe('Mensagens ativas — regras da tela', () => {
  const ok = { limiteDia: 2, limiteSemana: 4, templateRetorno: null, feriados: [] }

  it('valida limites como a API: inteiros, mínimo 1, semana ≥ dia', () => {
    expect(validarAtivas(ok)).toEqual({})
    expect(validarAtivas({ ...ok, limiteDia: 0 })).toHaveProperty('limiteDia')
    expect(validarAtivas({ ...ok, limiteDia: 1.5 })).toHaveProperty('limiteDia')
    expect(validarAtivas({ ...ok, limiteDia: 5, limiteSemana: 3 }).limiteSemana).toContain('menor')
  })

  it('feriado pelo seletor: só aquele dia ou todo ano', () => {
    expect(feriadoDeData('2026-12-25', false)).toBe('2026-12-25')
    expect(feriadoDeData('2026-12-25', true)).toBe('12-25')
    expect(feriadoDeData('', true)).toBeNull()
  })

  it('lista de feriados: sem repetir, ordenada, e o rótulo diz se é todo ano', () => {
    const l = adicionarFeriado(adicionarFeriado(['2026-11-20'], '12-25'), '12-25')
    expect(l).toEqual(['12-25', '2026-11-20'])
    expect(removerFeriado(l, '12-25')).toEqual(['2026-11-20'])
    expect(rotuloFeriado('12-25')).toBe('25/12 · todo ano')
    expect(rotuloFeriado('2026-11-20')).toBe('20/11/2026')
  })

  it('suspensão em português: qualidade volta sozinha; conta exige conferir', () => {
    expect(rotuloSuspensao('qualidade:FLAGGED')).toContain('Voltam sozinhas')
    expect(rotuloSuspensao('qualidade:DOWNGRADE:RED')).toContain('vermelho')
    expect(rotuloSuspensao('conta:ACCOUNT_VIOLATION')).toContain('Gerenciador do WhatsApp')
  })

  it('status de template vira badge com tom', () => {
    expect(badgeStatusTemplate('APPROVED')).toEqual({ rotulo: 'Aprovado', tom: 'sucesso' })
    expect(badgeStatusTemplate('PAUSED').tom).toBe('erro')
  })

  it('erro da API vai para o campo certo; papel insuficiente vira mensagem geral', () => {
    expect(erroDaApi('ativas.template_indisponivel', 'Escolha um aprovado.', ['templateRetorno'])).toEqual({ templateRetorno: 'Escolha um aprovado.' })
    expect(erroDaApi('acesso.papel_insuficiente', 'x', undefined).geral).toContain('administrador')
  })
})
