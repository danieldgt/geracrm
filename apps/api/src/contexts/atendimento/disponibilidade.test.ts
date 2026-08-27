import { describe, it, expect } from 'vitest'
import { ninguemDisponivel, motivoDisponibilidade, type QuemAtende } from './disponibilidade.js'

/**
 * ⚠️ Esta regra decide quando o robô fala com o cliente de alguém. Errar para um
 * lado deixa o cliente no vácuo; para o outro, põe o agente falando por cima de
 * um consultor que estava ali.
 */
const EQUIPE: QuemAtende = { vinculados: 3, logados: 2, ativos: 2, foraDoExpediente: false }
const com = (m: Partial<QuemAtende>): QuemAtende => ({ ...EQUIPE, ...m })

describe('Havendo quem atenda, o agente NÃO assume', () => {
  it('um consultor logado e não-ausente basta', () => {
    expect(ninguemDisponivel(com({ ativos: 1 }))).toBe(false)
  })

  it('e o motivo diz quantos estão de pé', () => {
    expect(motivoDisponibilidade(com({ ativos: 1 }))).toBe('1 de 3 disponíveis')
  })
})

describe('⚠️ Quando o agente assume', () => {
  /**
   * O caso que motivou a mudança (27/ago): o consultor entra em reunião às 14h,
   * o cliente escreve, e a regra antiga ("fora do expediente") deixava o produto
   * MUDO porque tecnicamente era horário comercial.
   */
  it('todos marcados como ausentes — mesmo dentro do expediente', () => {
    const q = com({ logados: 2, ativos: 0 })
    expect(ninguemDisponivel(q)).toBe(true)
    expect(motivoDisponibilidade(q)).toContain('ausentes')
  })

  it('ninguém logado na ferramenta', () => {
    const q = com({ logados: 0, ativos: 0 })
    expect(ninguemDisponivel(q)).toBe(true)
    expect(motivoDisponibilidade(q)).toBe('ninguém logado na ferramenta')
  })

  /**
   * ⚠️ Fora do expediente basta por si: não adianta ter gente logada às 23h se a
   * loja está fechada. Quem ficou trabalhando tarde não vira plantão sem querer.
   */
  it('fora do expediente vence até com todo mundo logado', () => {
    const q = com({ logados: 3, ativos: 3, foraDoExpediente: true })
    expect(ninguemDisponivel(q)).toBe(true)
    expect(motivoDisponibilidade(q)).toBe('fora do expediente')
  })

  it('número sem ninguém vinculado', () => {
    const q = com({ vinculados: 0, logados: 0, ativos: 0 })
    expect(ninguemDisponivel(q)).toBe(true)
    expect(motivoDisponibilidade(q)).toContain('nenhum usuário vinculado')
  })
})

describe('⚠️ O motivo é para ser lido por gente', () => {
  /**
   * Vai para `agente_sessao.motivo_entrada` e para o log. Sem ele, "por que o
   * robô falou com o meu cliente às 14h?" só teria resposta reconstruindo o
   * estado da equipe naquele minuto — que já passou.
   */
  it('cada situação tem uma frase própria, não um código', () => {
    const frases = [
      motivoDisponibilidade(com({ foraDoExpediente: true })),
      motivoDisponibilidade(com({ vinculados: 0, logados: 0, ativos: 0 })),
      motivoDisponibilidade(com({ logados: 0, ativos: 0 })),
      motivoDisponibilidade(com({ logados: 2, ativos: 0 })),
    ]
    expect(new Set(frases).size).toBe(4)   // nenhuma repetida
    for (const f of frases) expect(f).toMatch(/[a-zà-ú]/)  // texto, não código
  })
})
