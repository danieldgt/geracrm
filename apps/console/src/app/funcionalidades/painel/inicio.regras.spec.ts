import { describe, it, expect } from 'vitest'
import { alturasColunas, dataHoraCurta, horaNoFuso, rotuloMes, saudacaoPorHora, textoSaudacao } from './inicio.regras.js'

describe('saudação por hora', () => {
  it('limites: 05h bom dia, 12h boa tarde, 18h boa noite, 04h ainda noite', () => {
    expect(saudacaoPorHora(4)).toBe('Boa noite')
    expect(saudacaoPorHora(5)).toBe('Bom dia')
    expect(saudacaoPorHora(11)).toBe('Bom dia')
    expect(saudacaoPorHora(12)).toBe('Boa tarde')
    expect(saudacaoPorHora(17)).toBe('Boa tarde')
    expect(saudacaoPorHora(18)).toBe('Boa noite')
    expect(saudacaoPorHora(0)).toBe('Boa noite')
  })
  it('usa a hora do fuso do tenant, não a do navegador', () => {
    const instante = new Date('2026-11-03T15:30:00Z')   // 12:30 em São Paulo, 00:30 em Tóquio
    expect(horaNoFuso(instante, 'America/Sao_Paulo')).toBe(12)
    expect(horaNoFuso(instante, 'Asia/Tokyo')).toBe(0)
    expect(textoSaudacao(instante, 'America/Sao_Paulo', 'Daniel Tavares')).toBe('Boa tarde, Daniel')
    expect(textoSaudacao(instante, 'Asia/Tokyo', 'Daniel')).toBe('Boa noite, Daniel')
  })
  it('meia-noite local é hora 0 (e não 24)', () => {
    expect(horaNoFuso(new Date('2026-11-03T03:00:00Z'), 'America/Sao_Paulo')).toBe(0)
  })
  it('fuso inválido cai na hora local sem lançar; sem nome, só a saudação', () => {
    const instante = new Date('2026-11-03T15:30:00Z')
    expect(horaNoFuso(instante, 'Brasil/Ceara')).toBe(instante.getHours())
    expect(textoSaudacao(instante, 'America/Sao_Paulo', null)).toBe('Boa tarde')
    expect(textoSaudacao(instante, 'America/Sao_Paulo', '   ')).toBe('Boa tarde')
  })
})

describe('gráfico por mês', () => {
  it('rótulo curto do mês', () => {
    expect(rotuloMes('2026-09')).toBe('set/26')
    expect(rotuloMes('2027-01')).toBe('jan/27')
  })
  it('alturas: maior 100%, zero 0, positivo pequeno não some', () => {
    expect(alturasColunas([0, 5, 10])).toEqual([0, 50, 100])
    expect(alturasColunas([1, 1000])[0]).toBe(4)
    expect(alturasColunas([0, 0])).toEqual([0, 0])
  })
})

describe('data e hora curta', () => {
  it('formata no fuso do tenant', () => {
    expect(dataHoraCurta('2026-11-03T15:30:00Z', 'America/Sao_Paulo')).toContain('03/11')
    expect(dataHoraCurta('2026-11-03T15:30:00Z', 'America/Sao_Paulo')).toContain('12:30')
  })
})
