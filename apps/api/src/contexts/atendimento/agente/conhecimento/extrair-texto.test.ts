import { describe, it, expect } from 'vitest'
import { extrairTexto, MAX_BYTES_ARQUIVO, MAX_CARACTERES_DOCUMENTO } from './extrair-texto.js'

/**
 * Importar arquivo devolve TEXTO para revisão. PDF mínimo escrito à mão (uma
 * página, Helvetica, sem compressão) para não depender de fixture binária.
 */
function pdfComTexto(linha: string | null): Uint8Array {
  const conteudo = linha === null ? '' : `BT /F1 18 Tf 40 700 Td (${linha}) Tj ET`
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${conteudo.length} >>\nstream\n${conteudo}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offs: number[] = []
  objs.forEach((o, i) => { offs.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xref = pdf.length
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return new Uint8Array(Buffer.from(pdf, 'latin1'))
}

const utf8 = (s: string) => new Uint8Array(Buffer.from(s, 'utf8'))

describe('extrairTexto', () => {
  it('.txt: tira BOM, normaliza quebras de linha e espaços pendurados', async () => {
    const r = await extrairTexto('text/plain', utf8('﻿Prazo: 2 dias.  \r\n\r\n\r\n\r\nTroca em 7 dias.\r\n'))
    expect(r).toMatchObject({ ok: true, texto: 'Prazo: 2 dias.\n\nTroca em 7 dias.', paginas: null, avisos: [] })
    if (r.ok) expect(r.caracteres).toBe(r.texto.length)
  })

  it('.md vazio ou só espaço → sem_texto; arquivo de 0 bytes → arquivo_invalido', async () => {
    expect(await extrairTexto('text/markdown', utf8('  \n\n '))).toMatchObject({ ok: false, erro: 'sem_texto' })
    expect(await extrairTexto('text/plain', new Uint8Array())).toMatchObject({ ok: false, erro: 'arquivo_invalido' })
  })

  it('acima do teto de bytes → arquivo_grande, sem tentar ler', async () => {
    const grande = new Uint8Array(MAX_BYTES_ARQUIVO + 1)
    expect(await extrairTexto('application/pdf', grande)).toMatchObject({ ok: false, erro: 'arquivo_grande' })
  })

  it('texto fora de UTF-8 vira aviso, não erro', async () => {
    const latin1 = new Uint8Array(Buffer.from('Calça de alfaiataria', 'latin1'))
    const r = await extrairTexto('text/plain', latin1)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.avisos[0]).toMatch(/UTF-8/)
  })

  it('PDF com camada de texto → texto e páginas; PDF sem texto → sem_texto; lixo → arquivo_invalido', async () => {
    const ok = await extrairTexto('application/pdf', pdfComTexto('Prazo de entrega: 2 dias uteis'))
    expect(ok).toMatchObject({ ok: true, texto: 'Prazo de entrega: 2 dias uteis', paginas: 1 })
    expect(await extrairTexto('application/pdf', pdfComTexto(null))).toMatchObject({ ok: false, erro: 'sem_texto' })
    expect(await extrairTexto('application/pdf', utf8('isto não é um pdf'))).toMatchObject({ ok: false, erro: 'arquivo_invalido' })
  })

  it('texto maior que o documento aceita → ok com aviso para dividir', async () => {
    const r = await extrairTexto('text/plain', utf8('a'.repeat(MAX_CARACTERES_DOCUMENTO + 10)))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.avisos.join(' ')).toMatch(/Divida/)
  })
})
