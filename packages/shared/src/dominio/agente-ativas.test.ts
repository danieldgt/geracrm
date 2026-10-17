import { describe, it, expect } from 'vitest'
import {
  ATIVAS_PADRAO, configAtivas, corpoAtivas, contarVariaveis, lerConfigAtivas, normalizarFeriados, primeiroNome,
} from './agente-ativas.js'

describe('Config das ativas', () => {
  it('jsonb vazio ou torto cai nos padrões, campo a campo — o worker nunca quebra por config', () => {
    expect(lerConfigAtivas({})).toEqual(ATIVAS_PADRAO)
    expect(lerConfigAtivas(null)).toEqual(ATIVAS_PADRAO)
    expect(lerConfigAtivas({ limiteDia: 'três', limiteSemana: -1, templateRetorno: 'x' })).toEqual(ATIVAS_PADRAO)
    expect(lerConfigAtivas({ limiteDia: 3 })).toEqual({ ...ATIVAS_PADRAO, limiteDia: 3 })
  })

  it('semana nunca fica abaixo do dia, mesmo gravada assim', () => {
    expect(lerConfigAtivas({ limiteDia: 5, limiteSemana: 2 })).toMatchObject({ limiteDia: 5, limiteSemana: 5 })
  })

  it('o schema da borda recusa semana menor que dia e limite zero', () => {
    expect(configAtivas.safeParse({ limiteDia: 3, limiteSemana: 2, templateRetorno: null }).success).toBe(false)
    expect(configAtivas.safeParse({ limiteDia: 0, limiteSemana: 2, templateRetorno: null }).success).toBe(false)
    expect(configAtivas.safeParse({ limiteDia: 2, limiteSemana: 4, templateRetorno: null }).success).toBe(true)
  })

  it('feriados: aceita AAAA-MM-DD e MM-DD, recusa data inválida, deduplica e ordena', () => {
    expect(corpoAtivas.safeParse({ limiteDia: 2, limiteSemana: 4, templateRetorno: null, feriados: ['2026-13-01'] }).success).toBe(false)
    expect(corpoAtivas.safeParse({ limiteDia: 2, limiteSemana: 4, templateRetorno: null, feriados: ['12-25', '2026-11-20'] }).success).toBe(true)
    expect(normalizarFeriados(['12-25', '2026-11-20', '12-25', 'natal', 7])).toEqual(['12-25', '2026-11-20'])
  })
})

describe('Template de retorno', () => {
  it('conta variáveis posicionais distintas', () => {
    expect(contarVariaveis('Oi! Seu pedido está salvo.')).toBe(0)
    expect(contarVariaveis('Oi, {{1}}! Tudo bem, {{1}}?')).toBe(1)
    expect(contarVariaveis('Oi, {{1}}! Seu pedido {{2}}')).toBe(2)
  })

  it('primeiro nome para o {{1}}: nunca vazio e nunca um telefone', () => {
    expect(primeiroNome('Maria das Dores')).toBe('Maria')
    expect(primeiroNome('5585988887777')).toBe('cliente')
    expect(primeiroNome('  ')).toBe('cliente')
    expect(primeiroNome(null)).toBe('cliente')
  })
})
