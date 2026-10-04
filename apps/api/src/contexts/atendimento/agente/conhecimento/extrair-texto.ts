import { extractText, getDocumentProxy } from 'unpdf'

/**
 * IMPORTAR ARQUIVO PARA A BASE — devolve TEXTO para revisão, nunca salva.
 *
 * O dono sobe um FAQ em `.txt`, `.md` ou `.pdf`; a tela recebe o texto extraído,
 * mostra tamanho/páginas/avisos, e só grava quando a pessoa clicar em salvar.
 * PDF sem camada de texto (digitalizado) é falha TIPIFICADA: OCR não está no
 * escopo e a tela diz isso em vez de criar um documento vazio.
 */

export const TIPOS_ARQUIVO = ['text/plain', 'text/markdown', 'application/pdf'] as const
export type TipoArquivo = (typeof TIPOS_ARQUIVO)[number]

/** Teto do arquivo decodificado. Acima disso o PDF é quase sempre imagem, não texto. */
export const MAX_BYTES_ARQUIVO = 6 * 1024 * 1024
/** O mesmo teto do `conteudo` do documento (rotas-conhecimento). */
export const MAX_CARACTERES_DOCUMENTO = 150_000

export type ResultadoExtracao =
  | { ok: true; texto: string; caracteres: number; paginas: number | null; avisos: string[] }
  | { ok: false; erro: 'arquivo_invalido' | 'arquivo_grande' | 'sem_texto'; mensagem: string }

function limparTexto(bruto: string): string {
  return bruto
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export async function extrairTexto(tipo: TipoArquivo, bytes: Uint8Array): Promise<ResultadoExtracao> {
  if (bytes.byteLength === 0) return { ok: false, erro: 'arquivo_invalido', mensagem: 'O arquivo está vazio.' }
  if (bytes.byteLength > MAX_BYTES_ARQUIVO) {
    return { ok: false, erro: 'arquivo_grande', mensagem: `O arquivo passa de ${MAX_BYTES_ARQUIVO / 1024 / 1024} MB. Exporte só o texto ou divida em partes.` }
  }

  let texto: string
  let paginas: number | null = null
  const avisos: string[] = []

  if (tipo === 'application/pdf') {
    try {
      const doc = await getDocumentProxy(bytes)
      const r = await extractText(doc, { mergePages: true })
      paginas = r.totalPages
      texto = limparTexto(r.text)
    } catch {
      return { ok: false, erro: 'arquivo_invalido', mensagem: 'Não foi possível ler este PDF. Confira se o arquivo não está protegido ou corrompido.' }
    }
    if (texto.length === 0) {
      return { ok: false, erro: 'sem_texto', mensagem: 'Este PDF não tem camada de texto (parece digitalizado). Exporte o documento original como PDF de texto ou cole o conteúdo.' }
    }
  } else {
    texto = limparTexto(new TextDecoder('utf-8', { fatal: false }).decode(bytes))
    if (texto.length === 0) return { ok: false, erro: 'sem_texto', mensagem: 'O arquivo não tem texto.' }
    if (texto.includes('�')) avisos.push('Alguns caracteres não foram reconhecidos (o arquivo talvez não esteja em UTF-8). Revise acentos.')
  }

  if (texto.length > MAX_CARACTERES_DOCUMENTO) {
    avisos.push(`O texto tem ${texto.length.toLocaleString('pt-BR')} caracteres e o documento aceita até ${MAX_CARACTERES_DOCUMENTO.toLocaleString('pt-BR')}. Divida em mais de um documento.`)
  }
  return { ok: true, texto, caracteres: texto.length, paginas, avisos }
}
