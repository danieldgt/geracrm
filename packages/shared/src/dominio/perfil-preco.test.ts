import { describe, it, expect } from 'vitest'
import { PERFIS_PRECO, PERFIL_PRECO_PADRAO, perfilDeCotacao, ehPerfilPreco, rotuloPerfilPreco } from './perfil-preco.js'

describe('Perfil de preço', () => {
  it('reconhece os dois perfis do produto', () => {
    expect([...PERFIS_PRECO]).toEqual(['varejo', 'atacado'])
  })

  /**
   * ⚠️ O padrão é decisão de produto (ADR-019): B2B primeiro. Trocar isto muda o
   * preço que a tela e o agente cotam quando ninguém escolheu — por isso tem
   * teste, e não só constante.
   */
  it('sem escolha, cota ATACADO', () => {
    expect(perfilDeCotacao(undefined)).toBe('atacado')
    expect(perfilDeCotacao(null)).toBe('atacado')
    expect(perfilDeCotacao('')).toBe('atacado')
    expect(PERFIL_PRECO_PADRAO).toBe('atacado')
  })

  it('varejo é opt-in explícito', () => {
    expect(perfilDeCotacao('varejo')).toBe('varejo')
  })

  /** A tela manda o que o botão tem; o app e o webhook podem mandar diferente. */
  it('aceita com espaço e maiúscula', () => {
    expect(perfilDeCotacao(' Varejo ')).toBe('varejo')
    expect(perfilDeCotacao('ATACADO')).toBe('atacado')
  })

  it('valor desconhecido cai no padrão em vez de quebrar a busca', () => {
    expect(perfilDeCotacao('promocional')).toBe('atacado')
  })

  /**
   * ⚠️ A distinção que o agente vai precisar: "não disseram" não é "disseram
   * atacado". Sem isto, uma extração vazia cotaria atacado a um consumidor final.
   */
  it('ehPerfilPreco separa o declarado do assumido', () => {
    expect(ehPerfilPreco('varejo')).toBe(true)
    expect(ehPerfilPreco('atacado')).toBe(true)
    expect(ehPerfilPreco('promocional')).toBe(false)
    expect(ehPerfilPreco(undefined)).toBe(false)
    expect(ehPerfilPreco('')).toBe(false)
  })

  it('rótulo vai para tela e para texto de WhatsApp', () => {
    expect(rotuloPerfilPreco('varejo')).toBe('Varejo')
    expect(rotuloPerfilPreco('atacado')).toBe('Atacado')
  })
})
