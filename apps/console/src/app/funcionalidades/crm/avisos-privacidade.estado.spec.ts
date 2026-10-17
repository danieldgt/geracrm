import { describe, it, expect } from 'vitest'
import type { AvisoPrivacidadeExibido } from '@geracrm/shared'
import {
  CARREGANDO, falhaNaPrimeira, maisChegou, maisFalhou, pedirMais, primeiraPagina, rotuloOrigem, type EstadoAvisos,
} from './avisos-privacidade.estado.js'

const aviso = (id: string): AvisoPrivacidadeExibido => ({
  id, conversaId: 'c', canalId: 'k', mensagemId: `m-${id}`, texto: 'Esta conversa fica registrada.', versao: 'padrao',
  origem: 'agente', exibidoEm: '2026-10-01T10:00:00.000Z',
})

describe('Avisos de privacidade do contato — os cinco estados', () => {
  it('começa carregando', () => {
    expect(CARREGANDO).toEqual({ tipo: 'carregando' })
  })

  it('primeira página vazia é o estado VAZIO (ramo próprio, não lista vazia)', () => {
    expect(primeiraPagina({ itens: [], proximoCursor: null })).toEqual({ tipo: 'vazio' })
  })

  it('primeira página com itens → pronto, com o cursor da API', () => {
    const e = primeiraPagina({ itens: [aviso('a')], proximoCursor: 'cur' })
    expect(e).toMatchObject({ tipo: 'pronto', proximoCursor: 'cur', carregandoMais: false, erroMais: null })
  })

  it('403 → sem permissão (o bloco some); outros status → erro nomeado', () => {
    expect(falhaNaPrimeira(403)).toEqual({ tipo: 'sem_permissao' })
    expect(falhaNaPrimeira(500)).toMatchObject({ tipo: 'erro', mensagem: expect.stringMatching(/avisos de privacidade/) })
    expect(falhaNaPrimeira(0)).toMatchObject({ tipo: 'erro', mensagem: expect.stringMatching(/conexão/) })
  })

  it('carregar mais anexa sem duplicar e avança o cursor', () => {
    let e: EstadoAvisos = primeiraPagina({ itens: [aviso('a'), aviso('b')], proximoCursor: 'c1' })
    e = pedirMais(e)
    expect(e).toMatchObject({ carregandoMais: true })
    e = maisChegou(e, { itens: [aviso('b'), aviso('c')], proximoCursor: null })
    expect(e.tipo === 'pronto' && e.itens.map((i) => i.id)).toEqual(['a', 'b', 'c'])
    expect(e).toMatchObject({ proximoCursor: null, carregandoMais: false })
  })

  it('⚠️ falha no "carregar mais" é PARCIAL: a lista fica e o aviso é localizado', () => {
    const pronto = pedirMais(primeiraPagina({ itens: [aviso('a')], proximoCursor: 'c1' }))
    const e = maisFalhou(pronto)
    expect(e).toMatchObject({ tipo: 'pronto', carregandoMais: false, erroMais: expect.any(String) })
    expect(e.tipo === 'pronto' && e.itens).toHaveLength(1)
    // Tentar de novo limpa o aviso.
    expect(pedirMais(e)).toMatchObject({ carregandoMais: true, erroMais: null })
  })

  it('sem cursor, ou já carregando, "mais" não faz nada', () => {
    const fim = primeiraPagina({ itens: [aviso('a')], proximoCursor: null })
    expect(pedirMais(fim)).toBe(fim)
    const indo = pedirMais(primeiraPagina({ itens: [aviso('a')], proximoCursor: 'c' }))
    expect(pedirMais(indo)).toBe(indo)
  })

  it('rótulo da origem', () => {
    expect(rotuloOrigem('agente')).toBe('Abertura do agente')
    expect(rotuloOrigem('humano')).toBe('Enviado pela equipe')
  })
})
