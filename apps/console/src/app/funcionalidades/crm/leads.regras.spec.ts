import { describe, it, expect } from 'vitest'
import { idadeToque, semDonoImporta } from './leads.regras.js'

const AGORA = new Date('2026-09-03T12:00:00Z')
const atras = (ms: number) => new Date(AGORA.getTime() - ms).toISOString()
const DIA = 86_400_000

describe('Idade do último toque no card', () => {
  it('dado lead nunca tocado, então diz "sem contato" — nunca "hoje"', () => {
    // ⚠️ É justamente o card que a coluna precisa destacar.
    expect(idadeToque(null, AGORA)).toBe('sem contato')
  })

  it('dado toque de hoje e de ontem, então usa a palavra, não o número', () => {
    expect(idadeToque(atras(2 * 3_600_000), AGORA)).toBe('hoje')
    expect(idadeToque(atras(DIA + 3_600_000), AGORA)).toBe('ontem')
  })

  it('dado dias, semanas e meses, então encurta a unidade', () => {
    expect(idadeToque(atras(5 * DIA), AGORA)).toBe('há 5 d')
    expect(idadeToque(atras(70 * DIA), AGORA)).toBe('há 2 m')
    expect(idadeToque(atras(400 * DIA), AGORA)).toBe('há 1 a')
  })

  it('dado relógio adiantado no servidor, então "hoje" — nunca dia negativo', () => {
    expect(idadeToque(new Date(AGORA.getTime() + 3_600_000).toISOString(), AGORA)).toBe('hoje')
  })
})

describe('Destaque de "sem responsável"', () => {
  it('dado lead NOVO sem dono, então não destaca — é o estado normal', () => {
    // ⚠️ 709 cards laranja transformam a cor de atenção em cor de fundo.
    expect(semDonoImporta(null, 'novo')).toBe(false)
  })

  it('dado QUALIFICADO sem dono, então destaca — é trabalho aprovado e parado', () => {
    expect(semDonoImporta(null, 'qualificado')).toBe(true)
  })

  it('dado que tem dono, então nunca destaca', () => {
    expect(semDonoImporta('Ana', 'qualificado')).toBe(false)
  })
})
