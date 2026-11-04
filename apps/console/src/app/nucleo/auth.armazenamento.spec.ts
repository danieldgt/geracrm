import { describe, expect, it } from 'vitest'
import { criarArmazenamento, type StorageMinimo } from './auth.armazenamento.js'

const falso = (): StorageMinimo & { dados: Map<string, string> } => {
  const dados = new Map<string, string>()
  return {
    dados,
    getItem: (k) => dados.get(k) ?? null,
    setItem: (k, v) => { dados.set(k, v) },
    removeItem: (k) => { dados.delete(k) },
  }
}

describe('lembrar-me', () => {
  it('ligado grava no localStorage e limpa a sessionStorage', () => {
    const local = falso(), sessao = falso()
    sessao.setItem('t', 'velho')
    const a = criarArmazenamento(local, sessao)
    a.gravar('t', 'novo', true)
    expect(local.getItem('t')).toBe('novo')
    expect(sessao.getItem('t')).toBeNull()
    expect(a.ler('t')).toBe('novo')
    expect(a.lembrando('t')).toBe(true)
  })

  it('desligado grava só na sessionStorage — nada sobra no localStorage', () => {
    const local = falso(), sessao = falso()
    local.setItem('t', 'de-um-login-antigo')
    local.setItem('refresh', 'antigo')
    const a = criarArmazenamento(local, sessao)
    a.gravar('t', 'novo', false)
    a.gravar('refresh', 'r', false)
    expect(local.getItem('t')).toBeNull()
    expect(local.getItem('refresh')).toBeNull()
    expect(a.ler('t')).toBe('novo')
    expect(a.lembrando('t')).toBe(false)
  })

  it('remover limpa os dois lugares', () => {
    const local = falso(), sessao = falso()
    local.setItem('t', '1'); sessao.setItem('t', '2')
    const a = criarArmazenamento(local, sessao)
    a.remover('t')
    expect(a.ler('t')).toBeNull()
  })

  it('o refresh grava onde a sessão já mora', () => {
    const local = falso(), sessao = falso()
    const a = criarArmazenamento(local, sessao)
    a.gravar('t', 'a', false)
    a.gravar('t', 'b', a.lembrando('t'))
    expect(sessao.getItem('t')).toBe('b')
    expect(local.getItem('t')).toBeNull()
  })
})
