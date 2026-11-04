import { describe, it, expect } from 'vitest'
import {
  classificarErroMeta, limitarJanelaMarketing, validarJanelaCampanha,
  acaoPermitida, confirmacaoDoNomeConfere, custoCampanhaCentavos, custoPorVenda, duracaoDias, motivoPausaAutomatica,
} from './campanha.js'

describe('Campanhas v2 — regras puras', () => {
  it('duração em dias pelo lote diário (arredonda para cima; zero elegíveis = zero dias)', () => {
    expect(duracaoDias(0, 500)).toBe(0)
    expect(duracaoDias(500, 500)).toBe(1)
    expect(duracaoDias(501, 500)).toBe(2)
    expect(duracaoDias(10, 0)).toBe(10)
  })

  it('custo em centavos inteiros e custo por venda sem divisão por zero', () => {
    expect(custoCampanhaCentavos(100, 35)).toBe(3500)
    expect(custoCampanhaCentavos(-1, 35)).toBe(0)
    expect(custoPorVenda(3500, 0)).toBeNull()
    expect(custoPorVenda(3500, 3)).toBe(1167)
  })

  describe('pausa automática', () => {
    it('abaixo de 50 envios não pausa, por pior que seja a taxa', () => {
      expect(motivoPausaAutomatica({ enviados: 49, optouts: 49, processados: 49, falhas: 49 })).toBeNull()
    })
    it('opt-out acima de 2% dos enviados pausa; exatamente 2% não', () => {
      expect(motivoPausaAutomatica({ enviados: 100, optouts: 2, processados: 100, falhas: 0 })).toBeNull()
      expect(motivoPausaAutomatica({ enviados: 100, optouts: 3, processados: 100, falhas: 0 })).toBe('optout_alto')
    })
    it('falha acima de 10% dos processados pausa; exatamente 10% não; falha vence opt-out', () => {
      expect(motivoPausaAutomatica({ enviados: 90, optouts: 0, processados: 100, falhas: 10 })).toBeNull()
      expect(motivoPausaAutomatica({ enviados: 89, optouts: 0, processados: 100, falhas: 11 })).toBe('falhas_altas')
      expect(motivoPausaAutomatica({ enviados: 89, optouts: 10, processados: 100, falhas: 11 })).toBe('falhas_altas')
    })
  })

  it('ciclo de vida: só rascunho edita/inicia; pausar só em curso; retomar só pausada', () => {
    expect(acaoPermitida('rascunho', 'iniciar')).toBe(true)
    expect(acaoPermitida('agendada', 'editar')).toBe(false)
    expect(acaoPermitida('enviando', 'pausar')).toBe(true)
    expect(acaoPermitida('rascunho', 'pausar')).toBe(false)
    expect(acaoPermitida('pausada', 'retomar')).toBe(true)
    expect(acaoPermitida('concluida', 'cancelar')).toBe(false)
    expect(acaoPermitida('disparando', 'testar')).toBe(false)
  })

  it('confirmação do nome: igual ao nome, aparando espaços; vazio nunca confere', () => {
    expect(confirmacaoDoNomeConfere('Volta às aulas', '  Volta às aulas ')).toBe(true)
    expect(confirmacaoDoNomeConfere('Volta às aulas', 'volta às aulas')).toBe(false)
    expect(confirmacaoDoNomeConfere('   ', '   ')).toBe(false)
    expect(confirmacaoDoNomeConfere('X', undefined)).toBe(false)
  })

  it('erros da Meta: destinatário fora da taxa; número em risco pausa; sem código é outro', () => {
    expect(classificarErroMeta(131026)).toBe('destinatario')
    expect(classificarErroMeta('131049')).toBe('destinatario')
    expect(classificarErroMeta('131048')).toBe('numero_em_risco')
    expect(classificarErroMeta(368)).toBe('numero_em_risco')
    expect(classificarErroMeta(null)).toBe('outro')
    expect(classificarErroMeta('999')).toBe('outro')
  })

  it('janela de marketing: recorta o expediente a 08:00–21:00 e avisa', () => {
    expect(limitarJanelaMarketing({ seg: { de: '09:00', ate: '18:00' }, dom: null }))
      .toEqual({ horario: { seg: { de: '09:00', ate: '18:00' }, dom: null }, ajustada: false })
    expect(limitarJanelaMarketing({ seg: { de: '06:00', ate: '23:00' } }))
      .toEqual({ horario: { seg: { de: '08:00', ate: '21:00' } }, ajustada: true })
    // Vira a meia-noite (22h–02h): nada sobra na faixa → fechado.
    expect(limitarJanelaMarketing({ sex: { de: '22:00', ate: '02:00' } })).toEqual({ horario: { sex: null }, ajustada: true })
    // 18h–09h: sobram 18–21 (3h) e 08–09 (1h) → fica a maior.
    expect(limitarJanelaMarketing({ sab: { de: '18:00', ate: '09:00' } }).horario).toEqual({ sab: { de: '18:00', ate: '21:00' } })
  })

  it('janela da campanha: precisa de um dia aberto e cabe em 08:00–21:00', () => {
    expect(validarJanelaCampanha({ seg: null, dom: null })).toBe('vazia')
    expect(validarJanelaCampanha({ seg: { de: '07:00', ate: '12:00' } })).toBe('fora_do_permitido')
    expect(validarJanelaCampanha({ seg: { de: '20:00', ate: '09:00' } })).toBe('fora_do_permitido')
    expect(validarJanelaCampanha({ seg: { de: '08:00', ate: '21:00' } })).toBe('ok')
  })
})
