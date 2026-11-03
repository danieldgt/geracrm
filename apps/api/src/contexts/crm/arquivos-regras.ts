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
