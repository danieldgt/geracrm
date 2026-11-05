import { describe, it, expect } from 'vitest'
import {
  alternarConducao, corpoDevolucao, erroDevolucao, erroReatribuicao, pedeRecarregar, podeDevolver, podeReatribuir,
} from './devolucao.regras.js'

describe('quando mostrar os botões', () => {
  it('Devolver só com atendimento assumido por uma pessoa — e só para quem conduz ou para a gestão', () => {
    expect(podeDevolver({ estado: 'em_atendimento', meu: true })).toBe(true)
    expect(podeDevolver({ estado: 'em_atendimento', meu: false }, true)).toBe(true)
    expect(podeDevolver({ estado: 'em_atendimento', meu: false })).toBe(false)
    expect(podeDevolver({ estado: 'em_atendimento' })).toBe(false)
    expect(podeDevolver({ estado: 'na_fila', meu: true }, true)).toBe(false)
    expect(podeDevolver({ estado: 'encerrado', meu: true })).toBe(false)
    expect(podeDevolver(null, true)).toBe(false)
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
  it('devolução: observação vale em todo motivo, "Outro" a exige; o teto é 300', () => {
    expect(erroDevolucao({ motivo: null, observacao: '' })).toBeTruthy()
    expect(erroDevolucao({ motivo: 'fora_do_horario', observacao: '' })).toBeNull()
    expect(erroDevolucao({ motivo: 'fora_do_horario', observacao: 'volta amanhã' })).toBeNull()
    expect(erroDevolucao({ motivo: 'resolvido_pelo_humano', observacao: 'x'.repeat(301) })).toBeTruthy()
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

  it('o corpo só leva observação quando houver (em qualquer motivo)', () => {
    expect(corpoDevolucao({ motivo: 'fora_do_horario', observacao: '  ' })).toEqual({ motivo: 'fora_do_horario' })
    expect(corpoDevolucao({ motivo: 'resolvido_pelo_humano', observacao: ' já pagou ' })).toEqual({ motivo: 'resolvido_pelo_humano', observacao: 'já pagou' })
    expect(corpoDevolucao({ motivo: 'outro', observacao: ' ok ' })).toEqual({ motivo: 'outro', observacao: 'ok' })
  })

  it('chip de condução: clicar de novo desliga', () => {
    expect(alternarConducao(null, 'agente')).toBe('agente')
    expect(alternarConducao('agente', 'agente')).toBeNull()
    expect(alternarConducao('agente', 'humano')).toBe('humano')
  })
})

describe('erros que pedem Recarregar', () => {
  it('409 sem atendimento / conflito e 403 não é seu oferecem Recarregar; validação não', () => {
    expect(pedeRecarregar('conversa.sem_atendimento_humano')).toBe(true)
    expect(pedeRecarregar('atendimento.conflito')).toBe(true)
    expect(pedeRecarregar('atendimento.nao_e_seu')).toBe(true)
    expect(pedeRecarregar('devolucao.motivo_invalido')).toBe(false)
    expect(pedeRecarregar(null)).toBe(false)
  })
})
