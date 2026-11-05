import { describe, expect, it } from 'vitest'
import { criarArmazenamento, lerSessaoStaffGuardada, type StorageMinimo } from './auth.armazenamento.js'

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

describe('sessão de staff não é herdada', () => {
  const guardar = (a: ReturnType<typeof criarArmazenamento>, lembrar: boolean) =>
    a.gravar('staff', JSON.stringify({ token: 'ses_x', clienteNome: 'Cliente' }), lembrar)

  it('sem "Lembrar-me" a sessão de staff vai para a sessionStorage — nada no localStorage', () => {
    const local = falso(), sessao = falso()
    const a = criarArmazenamento(local, sessao)
    a.gravar('t', 'tok', false)
    guardar(a, a.lembrando('t'))
    expect(local.getItem('staff')).toBeNull()
    expect(sessao.getItem('staff')).not.toBeNull()
  })

  it('no boot, sessão de staff SEM login por baixo é descartada (produção)', () => {
    const local = falso(), sessao = falso()
    const a = criarArmazenamento(local, sessao)
    guardar(a, true)
    expect(lerSessaoStaffGuardada(a, 'staff', false, true)).toBeNull()
    expect(local.getItem('staff')).toBeNull()
  })

  it('com login por baixo a sessão é lida; em dev (sem exigir login) também; JSON corrompido não derruba', () => {
    const local = falso(), sessao = falso()
    const a = criarArmazenamento(local, sessao)
    guardar(a, true)
    expect(lerSessaoStaffGuardada(a, 'staff', true, true)).toEqual({ token: 'ses_x', clienteNome: 'Cliente' })
    expect(lerSessaoStaffGuardada(a, 'staff', false, false)?.token).toBe('ses_x')
    a.gravar('staff', '{quebrado', true)
    expect(lerSessaoStaffGuardada(a, 'staff', true, true)).toBeNull()
  })
})
