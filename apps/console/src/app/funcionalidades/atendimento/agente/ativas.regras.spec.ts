import { describe, it, expect } from 'vitest'
import {
  adicionarFeriado, badgeStatusTemplate, confirmacaoLiberar, erroDaApi, feriadoDeData, formatarNoFuso, removerFeriado, rotuloFeriado,
  lerDias, rotuloSuspensao, validarAtivas, confirmacaoRiscoReativacao, exigeConfirmarRiscoReativacao,
} from './ativas.regras.js'

describe('Mensagens ativas — regras da tela', () => {
  const ok = {
    limiteDia: 2, limiteSemana: 4, templateRetorno: null, descarteAposHoras: 0,
    reativacao: { ativa: false, dias: [30, 90], templateId: null, texto: null, limiteDia: 30 }, feriados: [],
  }

  it('descarte e reativação: horas de 0 a 720; prazos crescentes, 7 a 365, no máximo 3', () => {
    expect(validarAtivas({ ...ok, descarteAposHoras: 0 })).toEqual({})
    expect(validarAtivas({ ...ok, descarteAposHoras: 721 })).toHaveProperty('descarteAposHoras')
    expect(validarAtivas({ ...ok, descarteAposHoras: 1.5 })).toHaveProperty('descarteAposHoras')
    const dias = (d: number[]) => validarAtivas({ ...ok, reativacao: { ...ok.reativacao, dias: d } })
    expect(dias([7, 30, 365])).toEqual({})
    expect(dias([90, 30])).toHaveProperty('reativacao')
    expect(dias([5, 30])).toHaveProperty('reativacao')
    expect(dias([30, 400])).toHaveProperty('reativacao')
    expect(dias([7, 30, 90, 180])).toHaveProperty('reativacao')
    expect(dias([Number.NaN])).toHaveProperty('reativacao')
  })

  it('teto diário da reativação: inteiro de 1 a 200', () => {
    const teto = (n: number) => validarAtivas({ ...ok, reativacao: { ...ok.reativacao, limiteDia: n } })
    expect(teto(1)).toEqual({})
    expect(teto(200)).toEqual({})
    expect(teto(0)).toHaveProperty('reativacao')
    expect(teto(201)).toHaveProperty('reativacao')
    expect(teto(2.5)).toHaveProperty('reativacao')
  })

  it('⚠️ ligar a reativação no NÃO-OFICIAL pede confirmação digitada do risco de banimento; só ao ligar', () => {
    const ligada = { ...ok, reativacao: { ...ok.reativacao, ativa: true, texto: 'Oi!' } }
    expect(exigeConfirmarRiscoReativacao('whatsapp_nao_oficial', ok, ligada)).toBe(true)
    expect(exigeConfirmarRiscoReativacao('whatsapp_nao_oficial', null, ligada)).toBe(true)
    expect(exigeConfirmarRiscoReativacao('whatsapp_nao_oficial', ligada, { ...ligada, reativacao: { ...ligada.reativacao, limiteDia: 10 } })).toBe(false)
    expect(exigeConfirmarRiscoReativacao('whatsapp_nao_oficial', ok, ok)).toBe(false)
    expect(exigeConfirmarRiscoReativacao('whatsapp_oficial', ok, ligada)).toBe(false)
    const c = confirmacaoRiscoReativacao()
    expect(c).toMatchObject({ perigo: true, digitar: 'reativar' })
    expect(c.mensagem).toMatch(/banir/i)
  })

  it('lerDias aceita vírgula, ponto e vírgula e espaço; lixo vira NaN', () => {
    expect(lerDias('30, 90')).toEqual([30, 90])
    expect(lerDias(' 7;30 90 ')).toEqual([7, 30, 90])
    expect(lerDias('30, x').some(Number.isNaN)).toBe(true)
  })

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
    expect(rotuloSuspensao('qualidade:FLAGGED')).toContain('porque a qualidade do número caiu')
    // unknown event: never "porque a evento X"
    expect(rotuloSuspensao('qualidade:OUTRO')).toBe('Suspensas porque a Meta sinalizou o número (OUTRO). Voltam sozinhas quando a Meta normalizar.')
  })

  it('⚠️ próxima abertura no fuso do TENANT, não no do navegador', () => {
    const abre = '2026-10-21T12:00:00Z'
    expect(formatarNoFuso(abre, 'America/Sao_Paulo')).toBe('qua. 21/10 09:00')
    expect(formatarNoFuso(abre, 'Asia/Tokyo')).toBe('qua. 21/10 21:00')
    expect(formatarNoFuso('lixo', 'America/Sao_Paulo')).toBe('lixo')
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

describe('Liberar agora pede confirmação (Pvis2)', () => {
  it('dado o número em vermelho, então modal de perigo com confirmação digitada', () => {
    const c = confirmacaoLiberar('qualidade:FLAGGED:RED')
    expect(c).toMatchObject({ perigo: true, digitar: 'liberar' })
    expect(c.mensagem).toMatch(/vermelho/)
  })
  it('dado outra suspensão, então confirma sem digitar, citando a causa', () => {
    const c = confirmacaoLiberar('qualidade:DOWNGRADE')
    expect(c.digitar).toBeNull()
    expect(c.mensagem).toMatch(/reduziu o limite/)
  })
})
