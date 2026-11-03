import { describe, it, expect } from 'vitest'
import {
  alternarConducao, corpoDevolucao, erroDevolucao, erroReatribuicao, podeDevolver, podeReatribuir,
} from './devolucao.regras.js'

describe('quando mostrar os botões', () => {
  it('Devolver só com atendimento assumido por uma pessoa', () => {
    expect(podeDevolver({ estado: 'em_atendimento' })).toBe(true)
    expect(podeDevolver({ estado: 'na_fila' })).toBe(false)
    expect(podeDevolver({ estado: 'encerrado' })).toBe(false)
    expect(podeDevolver(null)).toBe(false)
  })

  it('Reatribuir só para a gestão e com atendimento aberto', () => {
    expect(podeReatribuir({ estado: 'em_atendimento' }, true)).toBe(true)
    expect(podeReatribuir({ estado: 'na_fila' }, true)).toBe(true)
    expect(podeReatribuir({ estado: 'em_atendimento' }, false)).toBe(false)
    expect(podeReatribuir({ estado: 'encerrado' }, true)).toBe(false)
    expect(podeReatribuir(null, true)).toBe(false)
  })
})

describe('formulários', () => {
  it('devolução: "Outro" exige descrição; o teto é 300', () => {
    expect(erroDevolucao({ motivo: null, observacao: '' })).toBeTruthy()
    expect(erroDevolucao({ motivo: 'fora_do_horario', observacao: '' })).toBeNull()
    expect(erroDevolucao({ motivo: 'outro', observacao: '   ' })).toBeTruthy()
    expect(erroDevolucao({ motivo: 'outro', observacao: 'cliente pediu' })).toBeNull()
    expect(erroDevolucao({ motivo: 'outro', observacao: 'x'.repeat(301) })).toBeTruthy()
  })

  it('reatribuição: usuário e motivo obrigatórios', () => {
    expect(erroReatribuicao({ usuarioId: null, motivo: 'x' })).toBeTruthy()
    expect(erroReatribuicao({ usuarioId: 'u1', motivo: ' ' })).toBeTruthy()
    expect(erroReatribuicao({ usuarioId: 'u1', motivo: 'férias' })).toBeNull()
    expect(erroReatribuicao({ usuarioId: 'u1', motivo: 'x'.repeat(301) })).toBeTruthy()
  })

  it('o corpo só leva observação quando houver', () => {
    expect(corpoDevolucao({ motivo: 'fora_do_horario', observacao: '  ' })).toEqual({ motivo: 'fora_do_horario' })
    expect(corpoDevolucao({ motivo: 'outro', observacao: ' ok ' })).toEqual({ motivo: 'outro', observacao: 'ok' })
  })

  it('chip de condução: clicar de novo desliga', () => {
    expect(alternarConducao(null, 'agente')).toBe('agente')
    expect(alternarConducao('agente', 'agente')).toBeNull()
    expect(alternarConducao('agente', 'humano')).toBe('humano')
  })
})
