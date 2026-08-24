import { describe, it, expect } from 'vitest'
import { abrirAvancado } from './canais.regras.js'

/**
 * ⚠️ O que importa aqui não é o DOM: é a decisão de QUANDO a área da equipe
 * aparece. Um teste que monta o componente e procura `<details>` falha por
 * espaçamento e para de falhar quando a regra muda.
 */
const CAMPOS = ['instancia', 'token', 'clientToken']

describe('Área da equipe (credencial do fornecedor)', () => {
  it('dado formulário limpo, então fica fechada — o cliente não tem esses dados', () => {
    expect(abrirAvancado({}, CAMPOS, false)).toBe(false)
  })

  it('dado clique no resumo, então abre', () => {
    expect(abrirAvancado({}, CAMPOS, true)).toBe(true)
  })

  it('⚠️ dado erro num campo de credencial, então abre SOZINHA', () => {
    // Sem isto, o servidor responde "confira os campos destacados" e não há
    // campo destacado na tela: o erro fica dentro de um bloco fechado.
    expect(abrirAvancado({ token: 'Obrigatório' }, CAMPOS, false)).toBe(true)
  })

  it('dado erro em campo de FORA da credencial, então continua fechada', () => {
    // Nome do número é do fluxo do cliente — não tem por que escancarar a
    // credencial do fornecedor por causa dele.
    expect(abrirAvancado({ nomeAmigavel: 'Obrigatório' }, CAMPOS, false)).toBe(false)
  })

  it('dado provedor sem campos declarados, então nunca abre sozinha', () => {
    expect(abrirAvancado({ token: 'Obrigatório' }, [], false)).toBe(false)
  })
})
