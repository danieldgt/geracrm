import { describe, it, expect } from 'vitest'
import { assinaturaConfere, chaveDoAnexoDeResposta } from './arquivos-regras.js'
import { dispositionAnexo } from '../atendimento/midia/armazenamento.js'

/** Assinatura ("magic bytes"): o conteúdo tem de confirmar o tipo que o cliente declarou. */
describe('assinaturaConfere', () => {
  const b = (...xs: number[]) => Buffer.from(xs)

  it('aceita o começo real de cada tipo permitido', () => {
    expect(assinaturaConfere('application/pdf', Buffer.from('%PDF-1.7\n...'))).toBe(true)
    expect(assinaturaConfere('image/png', b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe(true)
    expect(assinaturaConfere('image/jpeg', b(0xff, 0xd8, 0xff, 0xe0))).toBe(true)
    expect(assinaturaConfere('image/gif', Buffer.from('GIF89a'))).toBe(true)
    expect(assinaturaConfere('image/webp', Buffer.concat([Buffer.from('RIFF'), b(1, 2, 3, 4), Buffer.from('WEBPVP8 ')]))).toBe(true)
    expect(assinaturaConfere('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', b(0x50, 0x4b, 0x03, 0x04, 9))).toBe(true)
    expect(assinaturaConfere('application/vnd.openxmlformats-officedocument.wordprocessingml.document', b(0x50, 0x4b, 0x03, 0x04))).toBe(true)
    expect(assinaturaConfere('application/msword', b(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1))).toBe(true)
    expect(assinaturaConfere('text/csv', Buffer.from('nome;telefone\r\nAna;81999991111'))).toBe(true)
    expect(assinaturaConfere('text/plain', Buffer.from('olá'))).toBe(true)
  })

  it('.exe renomeado para .pdf (MZ) é recusado; binário com nulo não passa por texto', () => {
    expect(assinaturaConfere('application/pdf', Buffer.from('MZ\x90\x00\x03'))).toBe(false)
    expect(assinaturaConfere('image/png', Buffer.from('MZ'))).toBe(false)
    expect(assinaturaConfere('image/webp', Buffer.from('RIFF1234WAVE'))).toBe(false)
    expect(assinaturaConfere('text/plain', b(0x4d, 0x5a, 0x00, 0x01))).toBe(false)
    expect(assinaturaConfere('application/x-msdownload', Buffer.from('MZ'))).toBe(false)
    expect(assinaturaConfere('application/pdf', Buffer.alloc(0))).toBe(false)
  })

  it('a chave do anexo de formulário fica presa à resposta, com o tenant no prefixo', () => {
    expect(chaveDoAnexoDeResposta('T1', 'R1', 'A1', 'x.PDF')).toBe('tenant/T1/formulario/R1/A1.pdf')
  })

  it('URL assinada força download: attachment com nome ASCII seguro e o nome completo em filename*', () => {
    expect(dispositionAnexo('Proposta "final"/v2.pdf')).toBe(
      `attachment; filename="Proposta _final__v2.pdf"; filename*=UTF-8''${encodeURIComponent('Proposta "final"/v2.pdf')}`)
    expect(dispositionAnexo('ação.pdf')).toMatch(/^attachment; filename="acao\.pdf"; filename\*=UTF-8''a%C3%A7%C3%A3o\.pdf$/)
  })
})
