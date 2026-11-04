import { describe, it, expect } from 'vitest'
import {
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
})
