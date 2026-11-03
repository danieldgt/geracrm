import { describe, expect, it } from 'vitest'
import { chaveConferencia, compararConferencia, progressoImportacao } from '@geracrm/shared'
import {
  atualizadoHa, colunaRepetida, continuaPolling, decodificar, esperadoDoTexto, hashCurto, lerArquivo, mapearCampo, rotuloMotivo, sha256Hex,
  textoFaltando,
} from './importacao.regras.js'

const bytes = (t: string) => new TextEncoder().encode(t).buffer as ArrayBuffer

describe('leitura local do arquivo', () => {
  it('acha colunas, conta linhas e sugere o de-para', () => {
    const r = lerArquivo('﻿Cliente;Celular;E-mail\nAna;81998617049;a@x.com\nBia;81988887777;', 'contatos', 100)
    expect(r.problema).toBeNull()
    expect(r.linhas).toBe(2)
    expect(r.deParaSugerido).toMatchObject({ nome: 'Cliente', telefone: 'Celular', email: 'E-mail' })
  })
  it('avisa arquivo sem dados e arquivo grande', () => {
    expect(lerArquivo('Nome;Telefone\n', 'contatos', 10).problema).toMatch(/não tem linhas de dados/)
    expect(lerArquivo('Nome;Telefone\nA;1', 'contatos', 21 * 1024 * 1024).problema).toMatch(/20 MB/)
  })
  it('decodifica latin1 quando o UTF-8 vira lixo', () => {
    const latin1 = new Uint8Array([0x4a, 0x6f, 0x73, 0xe9]) // "José" em latin1
    expect(decodificar(latin1.buffer as ArrayBuffer)).toBe('José')
    expect(decodificar(bytes('José'))).toBe('José')
  })
})

describe('de-para', () => {
  it('mapear e desmapear um campo', () => {
    const a = mapearCampo({ nome: 'A' }, 'telefone', 'B')
    expect(a).toEqual({ nome: 'A', telefone: 'B' })
    expect(mapearCampo(a, 'telefone', '')).toEqual({ nome: 'A' })
  })
  it('diz o que falta; vendas pedem telefone ou documento', () => {
    expect(textoFaltando('contatos', { nome: 'A' }, ['A'])).toBe('Associe uma coluna a: Telefone.')
    expect(textoFaltando('contatos', { nome: 'A', telefone: 'B' }, ['A', 'B'])).toBe('')
    expect(textoFaltando('vendas', { data: 'D', valor: 'V' }, ['D', 'V'])).toBe('Associe uma coluna a: Telefone do contato ou CPF/CNPJ do contato.')
    expect(textoFaltando('contatos', { nome: 'X', telefone: 'B' }, ['A', 'B'])).toContain('Nome')
  })
  it('detecta coluna usada em dois campos', () => {
    expect(colunaRepetida({ nome: 'A', razao_social: 'A' }, 'nome')).toBe(true)
    expect(colunaRepetida({ nome: 'A', razao_social: 'B' }, 'nome')).toBe(false)
  })
})

describe('motivos e tempo', () => {
  it('traduz código e preserva o desconhecido', () => {
    expect(rotuloMotivo('telefone_invalido')).toMatch(/Telefone inválido/)
    expect(rotuloMotivo('codigo_novo')).toBe('codigo_novo')
    expect(rotuloMotivo(null)).toBe('')
  })
  it('atualizado há X', () => {
    const t0 = Date.parse('2026-11-03T12:00:00Z')
    expect(atualizadoHa('2026-11-03T11:59:58Z', t0)).toBe('atualizado agora')
    expect(atualizadoHa('2026-11-03T11:59:30Z', t0)).toBe('atualizado há 30 s')
    expect(atualizadoHa('2026-11-03T11:55:00Z', t0)).toBe('atualizado há 5 min')
    expect(atualizadoHa('2026-11-03T09:00:00Z', t0)).toBe('atualizado há 3 h')
  })
  it('polling só enquanto roda', () => {
    expect(continuaPolling('executando')).toBe(true)
    expect(continuaPolling('concluida')).toBe(false)
    expect(continuaPolling('falhou')).toBe(false)
  })
})

describe('progresso e conferência (regras compartilhadas com a API)', () => {
  it('progresso da barra', () => {
    expect(progressoImportacao({ linhas: 10, criados: 3, atualizados: 1, ignorados: 1, rejeitados: 0 }, 'executando').percentual).toBe(50)
    expect(progressoImportacao({ linhas: 10, criados: 10, atualizados: 0, ignorados: 0, rejeitados: 0 }, 'concluida').terminou).toBe(true)
  })
  it('esperado digitado: vazio e lixo viram sem esperado; divergência só com número válido', () => {
    expect(esperadoDoTexto(' 12 ')).toBe(12)
    expect(esperadoDoTexto('')).toBeNull()
    expect(esperadoDoTexto('12,5')).toBeNull()
    expect(esperadoDoTexto('-3')).toBeNull()
    const linha = { filial: 'Matriz', qualificacao: 'novo' as const, origem: null, total: 7 }
    const r = compararConferencia([linha], { [chaveConferencia(linha)]: esperadoDoTexto('9') })
    expect(r.linhas[0]).toMatchObject({ esperado: 9, diferenca: 2, divergente: true })
    expect(compararConferencia([linha], { [chaveConferencia(linha)]: esperadoDoTexto('') }).divergentes).toBe(0)
  })
})

describe('hash do arquivo', () => {
  it('sha256 em hex (vetor conhecido) e forma curta', async () => {
    const h = await sha256Hex(bytes('abc'))
    expect(h).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(hashCurto(h)).toBe('ba7816bf…f20015ad')
  })
})
