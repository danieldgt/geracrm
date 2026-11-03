/** Coluna de exportação: chave da linha e rótulo do cabeçalho. */
export interface ColunaCsv { chave: string; rotulo: string }

export interface OpcoesCsv {
  /** Números reais saem com vírgula decimal (padrão pt-BR do Excel; padrão `true`). */
  virgulaDecimal?: boolean
}

const SEPARADOR = ';'
const BOM = '﻿'

/** Início de texto que o Excel/Sheets interpretam como fórmula. */
const INICIO_DE_FORMULA = /^[=+\-@\t\r]/
/** Só dígitos com 11+ caracteres (CNPJ, CPF, telefone): o Excel viraria notação científica. */
const IDENTIFICADOR_LONGO = /^\d{11,}$/

/**
 * Neutraliza texto (NUNCA número real) para planilha: prefixo `'` em quem começa com
 * `= + - @ TAB CR` (injeção de fórmula, OWASP "CSV injection") e em string só de dígitos
 * com 11+ caracteres (preserva zeros à esquerda e evita notação científica). Escolhemos o
 * prefixo `'` em vez de `="..."`: o Excel o consome como marcador de texto e não exibe.
 */
export function neutralizarTexto(texto: string): string {
  return INICIO_DE_FORMULA.test(texto) || IDENTIFICADOR_LONGO.test(texto) ? `'${texto}` : texto
}

function campo(valor: unknown, virgulaDecimal: boolean): string {
  if (valor === null || valor === undefined) return ''
  let texto = typeof valor === 'number'
    ? (virgulaDecimal ? String(valor).replace('.', ',') : String(valor))
    : neutralizarTexto(String(valor))
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
  const virgula = opcoes.virgulaDecimal ?? true
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
  a.style.display = 'none'
  // Anexado ao DOM: o Firefox ignora click() em âncora solta. A URL só é revogada depois,
  // senão o download pode ser cancelado antes de começar.
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
