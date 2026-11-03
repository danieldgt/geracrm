import { describe, it, expect } from 'vitest'
import {
  camposObrigatoriosFaltando, chaveConferencia, compararConferencia, limparDePara, parseCsv, parseDataHora, parseQualificacao,
  progressoImportacao, reaisParaCentavos, sugerirDePara, dividirEtiquetas, CONTAGENS_ZERADAS,
} from './importacao.js'

describe('parseCsv', () => {
  it('detecta ; e , e remove o BOM', () => {
    const a = parseCsv('﻿Nome;Telefone\nAna;8199\n')
    expect(a.delimitador).toBe(';')
    expect(a.colunas).toEqual(['Nome', 'Telefone'])
    expect(a.linhas).toEqual([{ numero: 2, campos: ['Ana', '8199'] }])
    expect(parseCsv('nome,telefone\nBia,1').delimitador).toBe(',')
  })
  it('respeita aspas: delimitador, aspas escapadas e quebra de linha dentro do campo', () => {
    const r = parseCsv('nome;obs\r\n"Silva; Ana";"disse ""oi""\nem duas linhas"\r\nBeto;x\r\n')
    expect(r.linhas[0]!.campos).toEqual(['Silva; Ana', 'disse "oi"\nem duas linhas'])
    expect(r.linhas[1]).toEqual({ numero: 4, campos: ['Beto', 'x'] })
  })
  it('pula linha vazia mas mantém a numeração do arquivo', () => {
    const r = parseCsv('a;b\n1;2\n\n3;4')
    expect(r.linhas.map((l) => l.numero)).toEqual([2, 4])
  })
})

describe('reaisParaCentavos', () => {
  it.each([
    ['1.234,56', 123456], ['R$ 1.234,56', 123456], ['1234,5', 123450], ['1234.56', 123456], ['1.234', 123400],
    ['10', 1000], ['0,99', 99], ['-5,00', -500],
  ])('%s → %d', (t, c) => expect(reaisParaCentavos(t)).toBe(c))
  it.each(['', 'abc', '1,234,56', '12,345', '1.2.3'])('%s → null', (t) => expect(reaisParaCentavos(t)).toBeNull())
})

describe('parseDataHora', () => {
  it('lê dd/mm/aaaa e ISO no horário de Brasília', () => {
    expect(parseDataHora('20/05/2024')!.toISOString()).toBe('2024-05-20T15:00:00.000Z')
    expect(parseDataHora('2024-05-20 08:30')!.toISOString()).toBe('2024-05-20T11:30:00.000Z')
    expect(parseDataHora('2024-05-20T08:30:00Z')!.toISOString()).toBe('2024-05-20T08:30:00.000Z')
  })
  it('recusa data inexistente', () => {
    expect(parseDataHora('31/02/2024')).toBeNull()
    expect(parseDataHora('ontem')).toBeNull()
  })
})

describe('de-para', () => {
  const colunas = ['Cliente', 'Celular', 'E-mail', 'WhatsApp', 'CNPJ', 'Obs']
  it('sugere por nome normalizado, uma coluna por campo', () => {
    const d = sugerirDePara('contatos', colunas)
    expect(d).toMatchObject({ nome: 'Cliente', telefone: 'Celular', email: 'E-mail', whatsapp: 'WhatsApp', documento: 'CNPJ', observacoes: 'Obs' })
  })
  it('lista obrigatórios faltando; vendas exigem telefone ou documento', () => {
    expect(camposObrigatoriosFaltando('contatos', { nome: 'x' })).toEqual(['telefone'])
    expect(camposObrigatoriosFaltando('vendas', { data: 'd', valor: 'v' })).toEqual(['telefone_ou_documento'])
    expect(camposObrigatoriosFaltando('vendas', { data: 'd', valor: 'v', documento: 'c' })).toEqual([])
  })
  it('limpa de-para com coluna inexistente ou campo desconhecido', () => {
    expect(limparDePara('contatos', { nome: 'A', xpto: 'A', email: 'Z' }, ['A'])).toEqual({ nome: 'A' })
  })
})

describe('valores', () => {
  it('etiquetas separadas por | sem repetir', () => expect(dividirEtiquetas('vip| VIP |atacado||')).toEqual(['vip', 'atacado']))
  it('qualificação em texto livre', () => {
    expect(parseQualificacao('Desqualificado')).toBe('descartado')
    expect(parseQualificacao('talvez')).toBeUndefined()
  })
})

describe('progresso e conferência', () => {
  it('progresso conta o que já tem desfecho', () => {
    const c = { ...CONTAGENS_ZERADAS, linhas: 200, criados: 40, ignorados: 10 }
    expect(progressoImportacao(c, 'executando')).toEqual({ processadas: 50, total: 200, percentual: 25, terminou: false })
    expect(progressoImportacao(c, 'concluida').percentual).toBe(100)
    expect(progressoImportacao(CONTAGENS_ZERADAS, 'executando').percentual).toBe(0)
  })
  it('destaca divergência só onde há esperado válido', () => {
    const linhas = [
      { filial: 'Matriz', qualificacao: 'qualificado' as const, origem: 'Instagram', total: 10 },
      { filial: null, qualificacao: 'novo' as const, origem: null, total: 4 },
      { filial: 'Matriz', qualificacao: 'descartado' as const, origem: null, total: 2 },
    ]
    const r = compararConferencia(linhas, {
      [chaveConferencia(linhas[0]!)]: 12, [chaveConferencia(linhas[1]!)]: 4, [chaveConferencia(linhas[2]!)]: -1,
    })
    expect(r.linhas.map((l) => l.divergente)).toEqual([true, false, false])
    expect(r.linhas[0]!.diferenca).toBe(2)
    expect(r.divergentes).toBe(1)
    expect(r.totalReal).toBe(16)
    expect(r.totalEsperado).toBe(16)
  })
})
