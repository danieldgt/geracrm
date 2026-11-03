/** Coluna de exportação: chave da linha e rótulo do cabeçalho. */
export interface ColunaCsv { chave: string; rotulo: string }

export interface OpcoesCsv {
  /** Números saem com vírgula decimal (padrão pt-BR do Excel). Texto nunca é alterado. */
  virgulaDecimal?: boolean
}

const SEPARADOR = ';'
const BOM = '﻿'

function campo(valor: unknown, virgulaDecimal: boolean): string {
  if (valor === null || valor === undefined) return ''
  let texto = typeof valor === 'number' && virgulaDecimal ? String(valor).replace('.', ',') : String(valor)
  if (/[;"\r\n]/.test(texto)) texto = `"${texto.replace(/"/g, '""')}"`
  return texto
}

/**
 * Monta o CSV (separador ponto e vírgula, BOM UTF-8, CRLF). O BOM faz o Excel abrir
 * acentos certo; aspas dobradas e campo entre aspas preservam separador e quebra de linha.
 */
export function paraCsv(
  colunas: readonly ColunaCsv[],
  linhas: readonly Record<string, unknown>[],
  opcoes: OpcoesCsv = {},
): string {
  const virgula = opcoes.virgulaDecimal ?? false
  const cabecalho = colunas.map((c) => campo(c.rotulo, false)).join(SEPARADOR)
  const corpo = linhas.map((l) => colunas.map((c) => campo(l[c.chave], virgula)).join(SEPARADOR))
  return BOM + [cabecalho, ...corpo].map((l) => `${l}\r\n`).join('')
}

/** Dispara o download no navegador. Só roda em ambiente com DOM. */
export function baixarCsv(arquivo: string, conteudo: string): void {
  const blob = new Blob([conteudo], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = arquivo.endsWith('.csv') ? arquivo : `${arquivo}.csv`
  a.click()
  URL.revokeObjectURL(url)
}
