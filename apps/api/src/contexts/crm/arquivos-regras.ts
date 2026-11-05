/** Regras puras dos arquivos do contato: tipos aceitos, tamanho e chave do objeto. */

export const TAMANHO_MAX_ARQUIVO = 15 * 1024 * 1024

/** mime → extensões aceitas. A extensão tem de combinar com o mime declarado. */
const TIPOS: Record<string, readonly string[]> = {
  'application/pdf': ['pdf'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/webp': ['webp'],
  'image/gif': ['gif'],
  'application/vnd.ms-excel': ['xls'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
  'text/csv': ['csv'],
  'application/msword': ['doc'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
  'text/plain': ['txt'],
}

export function extensaoDe(nome: string): string {
  const i = nome.lastIndexOf('.')
  return i < 0 ? '' : nome.slice(i + 1).toLowerCase()
}

export function tipoPermitido(mime: string, nome: string): boolean {
  const exts = TIPOS[mime.toLowerCase()]
  return !!exts && exts.includes(extensaoDe(nome))
}

/** Nome seguro para exibir e para o Content-Disposition: sem caminho nem caractere de controle. */
export function nomeSeguro(bruto: string): string {
  const base = bruto.split(/[\\/]/).pop() ?? ''
  const limpo = [...base].filter((c) => c.charCodeAt(0) > 31 && c.charCodeAt(0) !== 127).join('').trim()
  return limpo.slice(0, 200)
}

/** Chave do objeto: o tenant é o prefixo (primeira linha de defesa, igual à mídia do chat). */
export function chaveDoArquivo(tenantId: string, contatoId: string, arquivoId: string, nome: string): string {
  const ext = extensaoDe(nome)
  return `tenant/${tenantId}/contato/${contatoId}/${arquivoId}${ext ? '.' + ext : ''}`
}

/**
 * Chave do anexo de FORMULÁRIO: presa à resposta (que ainda não existe no banco quando os bytes sobem —
 * o id é gerado antes, para o upload acontecer FORA da transação).
 */
export function chaveDoAnexoDeResposta(tenantId: string, respostaId: string, arquivoId: string, nome: string): string {
  const ext = extensaoDe(nome)
  return `tenant/${tenantId}/formulario/${respostaId}/${arquivoId}${ext ? '.' + ext : ''}`
}

const comeca = (b: Buffer, assinatura: readonly number[], deslocamento = 0): boolean =>
  b.length >= deslocamento + assinatura.length && assinatura.every((x, i) => b[deslocamento + i] === x)

const ZIP = [0x50, 0x4b, 0x03, 0x04] as const
/** Documento do Office antigo (xls/doc): Compound File Binary. */
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const

/** Texto (txt/csv): sem byte nulo nos primeiros 8 KB — binário renomeado tem nulo logo no começo. */
const pareceTexto = (b: Buffer): boolean => !b.subarray(0, 8192).includes(0)

/**
 * O CONTEÚDO confere com o tipo declarado? (assinatura / "magic bytes").
 *
 * ⚠️ Mime e extensão vêm do cliente: `virus.exe` renomeado para `contrato.pdf` com `application/pdf`
 * passa no `tipoPermitido`. Aqui se olha o começo do arquivo. Sem dependência nova: os tipos aceitos
 * são poucos e as assinaturas são fixas. xlsx/docx são ZIP (o conteúdo interno não é aberto aqui).
 */
export function assinaturaConfere(mime: string, bytes: Buffer): boolean {
  switch (mime.toLowerCase()) {
    case 'application/pdf': return comeca(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]) // %PDF-
    case 'image/png': return comeca(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    case 'image/jpeg': return comeca(bytes, [0xff, 0xd8, 0xff])
    case 'image/gif': return comeca(bytes, [0x47, 0x49, 0x46, 0x38]) // GIF8
    case 'image/webp': return comeca(bytes, [0x52, 0x49, 0x46, 0x46]) && comeca(bytes, [0x57, 0x45, 0x42, 0x50], 8) // RIFF....WEBP
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return comeca(bytes, ZIP)
    case 'application/vnd.ms-excel':
    case 'application/msword':
      return comeca(bytes, OLE)
    case 'text/csv':
    case 'text/plain':
      return pareceTexto(bytes)
    default: return false
  }
}
