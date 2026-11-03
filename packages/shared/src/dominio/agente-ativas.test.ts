import { describe, it, expect } from 'vitest'
import {
  ATIVAS_PADRAO, REATIVACAO_PADRAO, reativacaoAtivas, configAtivas, corpoAtivas, contarVariaveis, lerConfigAtivas, normalizarFeriados, primeiroNome,
  templateDeRetornoCompativel,
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
    const novos = { descarteAposHoras: 72, reativacao: REATIVACAO_PADRAO }
    expect(configAtivas.safeParse({ limiteDia: 3, limiteSemana: 2, templateRetorno: null, ...novos }).success).toBe(false)
    expect(configAtivas.safeParse({ limiteDia: 0, limiteSemana: 2, templateRetorno: null, ...novos }).success).toBe(false)
    expect(configAtivas.safeParse({ limiteDia: 2, limiteSemana: 4, templateRetorno: null, ...novos }).success).toBe(true)
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

  it('compatível com o retorno: sem variável ou SÓ o {{1}} — {{2}} sozinho não serve', () => {
    expect(templateDeRetornoCompativel('Oi! Seu pedido está salvo.')).toBe(true)
    expect(templateDeRetornoCompativel('Oi, {{1}}! Tudo bem, {{ 1 }}?')).toBe(true)
    expect(templateDeRetornoCompativel('Oi! Seu pedido {{2}}')).toBe(false)
    expect(templateDeRetornoCompativel('Oi, {{1}}! Pedido {{2}}')).toBe(false)
  })

  it('primeiro nome para o {{1}}: nunca vazio e nunca um telefone', () => {
    expect(primeiroNome('Maria das Dores')).toBe('Maria')
    expect(primeiroNome('5585988887777')).toBe('cliente')
    expect(primeiroNome('  ')).toBe('cliente')
    expect(primeiroNome(null)).toBe('cliente')
  })
})

describe('Descarte após a cadência e reativação (G5)', () => {
  const base = { limiteDia: 2, limiteSemana: 4, templateRetorno: null, feriados: [] as string[] }
  const reat = (dias: number[], extra = {}) => ({ ativa: true, dias, templateId: null, texto: null, ...extra })

  it('padrões: descarta após 72 h, reativação desligada em 30 e 90 dias', () => {
    expect(ATIVAS_PADRAO.descarteAposHoras).toBe(72)
    expect(ATIVAS_PADRAO.reativacao).toEqual({ ativa: false, dias: [30, 90], templateId: null, texto: null })
  })

  it('dias: crescentes, de 7 a 365, no máximo 3', () => {
    expect(reativacaoAtivas.safeParse(reat([30, 90])).success).toBe(true)
    expect(reativacaoAtivas.safeParse(reat([7, 30, 365])).success).toBe(true)
    expect(reativacaoAtivas.safeParse(reat([90, 30])).success).toBe(false)
    expect(reativacaoAtivas.safeParse(reat([30, 30])).success).toBe(false)
    expect(reativacaoAtivas.safeParse(reat([6, 30])).success).toBe(false)
    expect(reativacaoAtivas.safeParse(reat([30, 366])).success).toBe(false)
    expect(reativacaoAtivas.safeParse(reat([7, 30, 90, 180])).success).toBe(false)
    expect(reativacaoAtivas.safeParse(reat([])).success).toBe(false)
  })

  it('o corpo do PUT aceita sem os campos novos (cliente antigo) e limita as horas do descarte', () => {
    expect(corpoAtivas.safeParse(base).success).toBe(true)
    expect(corpoAtivas.safeParse({ ...base, descarteAposHoras: 0 }).success).toBe(true)
    expect(corpoAtivas.safeParse({ ...base, descarteAposHoras: 721 }).success).toBe(false)
    expect(corpoAtivas.safeParse({ ...base, descarteAposHoras: -1 }).success).toBe(false)
  })

  it('leitura tolerante: reativação torta cai no padrão desligada', () => {
    expect(lerConfigAtivas({ reativacao: { ativa: true, dias: [90, 30] } }).reativacao).toEqual(REATIVACAO_PADRAO)
    expect(lerConfigAtivas({ descarteAposHoras: 'x' }).descarteAposHoras).toBe(72)
    expect(lerConfigAtivas({ descarteAposHoras: 0 }).descarteAposHoras).toBe(0)
    expect(lerConfigAtivas({ reativacao: reat([15, 45], { texto: 'oi' }) }).reativacao).toMatchObject({ ativa: true, dias: [15, 45], texto: 'oi' })
  })
})
