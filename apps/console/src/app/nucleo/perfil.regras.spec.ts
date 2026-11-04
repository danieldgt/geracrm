import { describe, expect, it } from 'vitest'
import {
  camposDoCorpo, corpoDoPerfil, erroDaFoto, errosDaSenha, errosDoPerfil, formDoPerfil, iniciaisDe, mudouOPerfil,
} from './perfil.regras.js'

describe('meu perfil — regras puras', () => {
  it('o formulário nasce do perfil e o corpo grava só dígitos no telefone', () => {
    const f = formDoPerfil({ nome: 'Ana', telefone: '11988887777', cargo: null })
    expect(f).toEqual({ nome: 'Ana', telefone: '11988887777', cargo: '' })
    expect(corpoDoPerfil({ nome: ' Ana ', telefone: '(11) 98888-7777', cargo: ' Vendedora ' }))
      .toEqual({ nome: 'Ana', telefone: '11988887777', cargo: 'Vendedora' })
    expect(corpoDoPerfil({ nome: 'Ana', telefone: '', cargo: '' })).toEqual({ nome: 'Ana', telefone: null, cargo: null })
  })

  it('valida nome, telefone e cargo; telefone vazio é permitido', () => {
    expect(errosDoPerfil({ nome: '', telefone: '', cargo: '' })).toEqual({ nome: 'Informe o seu nome.' })
    expect(errosDoPerfil({ nome: 'Ana', telefone: '(11) 9', cargo: '' })).toHaveProperty('telefone')
    expect(errosDoPerfil({ nome: 'Ana', telefone: '(11) 98888-7777', cargo: '' })).toEqual({})
    expect(errosDoPerfil({ nome: 'Ana', telefone: '', cargo: 'x'.repeat(81) })).toHaveProperty('cargo')
  })

  it('mudou: ignora máscara e espaços', () => {
    const o = formDoPerfil({ nome: 'Ana', telefone: '11988887777', cargo: 'Vendas' })
    expect(mudouOPerfil(o, { nome: ' Ana ', telefone: '(11) 98888-7777', cargo: 'Vendas' })).toBe(false)
    expect(mudouOPerfil(o, { ...o, cargo: 'Gestão' })).toBe(true)
  })

  it('422 por campo vira o mapa do formulário; erro sem campos não', () => {
    expect(camposDoCorpo({ campos: { telefone: 'Telefone inválido.' } })).toEqual({ telefone: 'Telefone inválido.' })
    expect(camposDoCorpo({ campos: {} })).toBeNull()
    expect(camposDoCorpo({ campos: ['senhaAtual'] })).toBeNull()
    expect(camposDoCorpo(null)).toBeNull()
  })

  it('foto: tipo e tamanho', () => {
    expect(erroDaFoto({ type: 'image/png', size: 1000 })).toBeNull()
    expect(erroDaFoto({ type: 'image/gif', size: 1000 })).toMatch(/JPG, PNG ou WebP/)
    expect(erroDaFoto({ type: 'image/jpeg', size: 3 * 1024 * 1024 })).toMatch(/2 MB/)
    expect(erroDaFoto({ type: 'image/jpeg', size: 0 })).toMatch(/vazio/)
  })

  it('iniciais: primeira e última palavra', () => {
    expect(iniciaisDe('Ana Maria Souza')).toBe('AS')
    expect(iniciaisDe('Ana')).toBe('A')
    expect(iniciaisDe('  ')).toBe('?')
  })

  it('senha: atual obrigatória, mínimo, diferente da atual e confirmação igual', () => {
    expect(errosDaSenha({ atual: '', nova: '', confirmacao: '' })).toMatchObject({ senhaAtual: expect.any(String), novaSenha: expect.any(String) })
    expect(errosDaSenha({ atual: 'Antiga#123', nova: 'Antiga#123', confirmacao: 'Antiga#123' })['novaSenha']).toMatch(/diferente/)
    expect(errosDaSenha({ atual: 'Antiga#123', nova: 'Nova#12345', confirmacao: 'Outra#12345' })['confirmacao']).toMatch(/confirmação/)
    expect(errosDaSenha({ atual: 'Antiga#123', nova: 'Nova#12345', confirmacao: 'Nova#12345' })).toEqual({})
  })
})
