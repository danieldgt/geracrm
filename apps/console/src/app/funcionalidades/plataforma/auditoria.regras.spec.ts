import { describe, it, expect } from 'vitest'
import {
  COLUNAS_CSV, FILTRO_VAZIO, TAMANHO_BUSCA_MAX, definicoesDoEvento, detalheDoEvento, filtrosAtivos, formatarQuando,
  intervaloIso, jsonDoEvento, linhasDoRastroCsv, montarQueryAuditoria, opcoesDeUsuarios, rotuloAcao,
  type EntradaAuditoria,
} from './auditoria.regras.js'
import { paraCsv } from '../../compartilhado/ui/csv.js'

const entrada = (over: Partial<EntradaAuditoria> = {}): EntradaAuditoria => ({
  id: '0190c000-0000-7000-8000-000000000001',
  criadoEm: '2026-11-03T12:00:00.123456Z',
  acao: 'mensagem.apagada',
  entidade: 'mensagem',
  entidadeId: 'm-1',
  atorNome: 'Ana',
  dados: { paraTodos: true },
  ...over,
})

describe('rotulo e detalhe da ação', () => {
  it('rotula as ações conhecidas e devolve o código cru para as outras', () => {
    expect(rotuloAcao('atendimento.assumido')).toBe('Assumiu o atendimento')
    expect(rotuloAcao('mensagem.editada')).toBe('Editou uma mensagem')
    expect(rotuloAcao('carteira.transferida')).toBe('carteira.transferida')
  })

  it('detalhe vem de dados: protocolo e "para todos"; o resto é vazio', () => {
    expect(detalheDoEvento('atendimento.assumido', { protocolo: 42 })).toBe('Protocolo #42')
    expect(detalheDoEvento('mensagem.apagada', { paraTodos: true })).toBe('Para todos')
    expect(detalheDoEvento('mensagem.apagada', { paraTodos: false })).toBe('Só para mim')
    expect(detalheDoEvento('mensagem.editada', { x: 1 })).toBe('')
    expect(detalheDoEvento('mensagem.editada', null)).toBe('')
  })
})

describe('formatarQuando', () => {
  it('formata em horário local, aceitando fração de até 6 dígitos', () => {
    const d = new Date(2026, 10, 3, 8, 5, 9)
    const iso = d.toISOString().replace('.000Z', '.123456Z')
    expect(formatarQuando(iso)).toBe('03/11/2026 08:05')
    expect(formatarQuando(iso, true)).toBe('03/11/2026 08:05:09')
  })

  it('texto inválido volta cru, sem quebrar a tabela', () => {
    expect(formatarQuando('não é data')).toBe('não é data')
  })
})

describe('intervaloIso', () => {
  it('sem datas, sem limite', () => {
    expect(intervaloIso('', '')).toEqual({ de: null, ate: null })
  })

  it('início é meia-noite local do primeiro dia; fim vira o início do dia SEGUINTE (ate exclusivo)', () => {
    const r = intervaloIso('2026-11-03', '2026-11-05')
    expect(r.de).toBe(new Date(2026, 10, 3).toISOString())
    expect(r.ate).toBe(new Date(2026, 10, 6).toISOString())
  })

  it('o mesmo dia nos dois campos cobre o dia inteiro', () => {
    const r = intervaloIso('2026-11-03', '2026-11-03')
    expect(r.de).toBe(new Date(2026, 10, 3).toISOString())
    expect(r.ate).toBe(new Date(2026, 10, 4).toISOString())
  })
})

describe('montarQueryAuditoria', () => {
  it('sem filtro e sem cursor, a URL não leva parâmetro nenhum', () => {
    expect(montarQueryAuditoria(FILTRO_VAZIO)).toBe('')
  })

  it('o cursor entra junto dos filtros, sem alterar nenhum', () => {
    const q = new URLSearchParams(montarQueryAuditoria({ ...FILTRO_VAZIO, acao: 'mensagem.apagada' }, 'abc=='))
    expect(q.get('cursor')).toBe('abc==')
    expect(q.get('acao')).toBe('mensagem.apagada')
  })

  it('apara a busca e corta no limite do servidor', () => {
    const q = new URLSearchParams(montarQueryAuditoria({ ...FILTRO_VAZIO, busca: '  ' + 'x'.repeat(200) }))
    expect(q.get('q')).toBe('x'.repeat(TAMANHO_BUSCA_MAX))
    expect(new URLSearchParams(montarQueryAuditoria({ ...FILTRO_VAZIO, busca: '   ' })).has('q')).toBe(false)
  })

  it('usuário e período viram atorId, de e ate', () => {
    const q = new URLSearchParams(montarQueryAuditoria({
      ...FILTRO_VAZIO, atorId: '0190c000-0000-7000-8000-0000000000aa', inicio: '2026-11-03', fim: '2026-11-03',
    }))
    expect(q.get('atorId')).toBe('0190c000-0000-7000-8000-0000000000aa')
    expect(q.get('de')).toBe(new Date(2026, 10, 3).toISOString())
    expect(q.get('ate')).toBe(new Date(2026, 10, 4).toISOString())
  })
})

describe('filtrosAtivos', () => {
  it('só considera filtro preenchido (busca só com espaço não conta)', () => {
    expect(filtrosAtivos(FILTRO_VAZIO)).toBe(false)
    expect(filtrosAtivos({ ...FILTRO_VAZIO, busca: '   ' })).toBe(false)
    expect(filtrosAtivos({ ...FILTRO_VAZIO, fim: '2026-11-03' })).toBe(true)
  })
})

describe('definições do detalhe e JSON', () => {
  it('ator ausente vira "Sistema"; o JSON sai indentado e como texto', () => {
    const defs = definicoesDoEvento(entrada({ atorNome: null, dados: { a: '<b>' } }))
    expect(defs.find((d) => d.rotulo === 'Quem')?.valor).toBe('Sistema')
    expect(defs.find((d) => d.rotulo === 'Ação')?.valor).toBe('Apagou uma mensagem')
    expect(jsonDoEvento({ a: '<b>' })).toBe('{\n  "a": "<b>"\n}')
    expect(jsonDoEvento(null)).toBe('null')
  })
})

describe('CSV do rastro', () => {
  it('linhas usam as chaves das colunas e saem com o rótulo da tela', () => {
    const linhas = linhasDoRastroCsv([entrada(), entrada({ atorNome: null, acao: 'atendimento.assumido', dados: { protocolo: 7 } })])
    expect(Object.keys(linhas[0] ?? {}).sort()).toEqual(COLUNAS_CSV.map((c) => c.chave).sort())
    expect(linhas[1]?.['quem']).toBe('Sistema')
    expect(linhas[1]?.['detalhe']).toBe('Protocolo #7')
    const csv = paraCsv(COLUNAS_CSV, linhas)
    expect(csv.split('\r\n')[0]).toBe('﻿Quando;Quem;Ação;Entidade;ID da entidade;Detalhe')
  })

  it('campo com ponto e vírgula ou aspas sai entre aspas (não quebra a coluna)', () => {
    const linhas = linhasDoRastroCsv([entrada({ entidadeId: 'a;"b"' })])
    expect(paraCsv(COLUNAS_CSV, linhas)).toContain('"a;""b"""')
  })
})

describe('opções de usuário', () => {
  it('a equipe vira opções com o id como valor', () => {
    expect(opcoesDeUsuarios([{ id: 'u1', nome: 'Ana' }])).toEqual([{ valor: 'u1', rotulo: 'Ana' }])
  })
})
