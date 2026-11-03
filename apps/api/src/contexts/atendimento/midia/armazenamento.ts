import { randomUUID } from 'node:crypto'
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

/**
 * Armazenamento de mídia do chat (E5-14) — bucket S3-compatível (Railway).
 *
 * ⚠️ Mídia NUNCA no banco: base64 de imagem/áudio incharia a tabela `mensagem`
 * e derrubaria a paginação. O banco guarda só a CHAVE; os bytes vivem aqui, e a
 * leitura devolve URL ASSINADA de expiração curta (o cliente não vê credencial).
 *
 * ⚠️ A chave é namespaced por tenant (`tenant/{T}/{uuid}`): o prefixo é a
 * primeira linha de defesa contra servir mídia de um tenant para outro.
 */

const endpoint = process.env.MIDIA_ENDPOINT ?? ''
const bucket = process.env.MIDIA_BUCKET ?? ''
const region = process.env.MIDIA_REGION || 'auto'

/** Configurado? Sem bucket, o envio degrada para base64 em vez de quebrar. */
export function midiaHabilitada(): boolean {
  return !!(endpoint && bucket && process.env.MIDIA_ACCESS_KEY_ID && process.env.MIDIA_SECRET_ACCESS_KEY)
}

let clienteCache: S3Client | null = null
function cliente(): S3Client {
  if (!clienteCache) {
    clienteCache = new S3Client({
      endpoint,
      region,
      // urlStyle=virtual-host (padrão do provedor); não forçar path-style.
      forcePathStyle: false,
      credentials: {
        accessKeyId: process.env.MIDIA_ACCESS_KEY_ID!,
        secretAccessKey: process.env.MIDIA_SECRET_ACCESS_KEY!,
      },
    })
  }
  return clienteCache
}

const EXT_POR_MIME: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/webm': 'weba',
}

/** Sobe os bytes e devolve a CHAVE (o que vai para o banco). */
export async function subirMidia(tenantId: string, bytes: Buffer, mime: string): Promise<string> {
  const ext = EXT_POR_MIME[mime] ?? 'bin'
  const chave = `tenant/${tenantId}/${randomUUID()}.${ext}`
  await cliente().send(new PutObjectCommand({ Bucket: bucket, Key: chave, Body: bytes, ContentType: mime }))
  return chave
}

/**
 * URL ASSINADA de leitura, curta. Usada na thread (o cliente renderiza) e no
 * envio ao provedor (que busca a imagem por HTTP). Curta de propósito: o link
 * não deve virar acesso permanente se vazar de um log.
 */
export async function urlAssinada(
  chave: string, ttlSegundos = 3600, opcoes: { baixarComo?: string; tipo?: string } = {},
): Promise<string> {
  return getSignedUrl(cliente(), new GetObjectCommand({
    Bucket: bucket, Key: chave,
    ...(opcoes.baixarComo ? { ResponseContentDisposition: dispositionAnexo(opcoes.baixarComo) } : {}),
    ...(opcoes.tipo ? { ResponseContentType: opcoes.tipo } : {}),
  }), { expiresIn: ttlSegundos })
}

/**
 * `Content-Disposition: attachment` para arquivo enviado por terceiro (formulário público, ficha).
 *
 * ⚠️ Sem isto o navegador ABRE o arquivo na origem do bucket: um HTML/SVG disfarçado roda ali. Com
 * `attachment` ele baixa. O S3 não deixa sobrescrever `X-Content-Type-Options` por URL assinada — o
 * `nosniff` fica para a política do bucket; o tipo é forçado por `ResponseContentType` (o que validamos).
 * O nome vai ASCII no `filename` (aspas e barras fora) e completo no `filename*` (RFC 5987).
 */
export function dispositionAnexo(nome: string): string {
  const ascii = nome.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/["\\/;]/g, '_').trim() || 'arquivo'
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(nome).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`
}

/** Sobe bytes numa chave JÁ montada pelo chamador (arquivos do contato). A chave leva o tenant no prefixo. */
export async function subirObjeto(chave: string, bytes: Buffer, mime: string): Promise<void> {
  await cliente().send(new PutObjectCommand({ Bucket: bucket, Key: chave, Body: bytes, ContentType: mime }))
}

/** Remove um objeto do bucket. Inexistente não é erro (S3 responde 204). */
export async function removerObjeto(chave: string): Promise<void> {
  await cliente().send(new DeleteObjectCommand({ Bucket: bucket, Key: chave }))
}

/** É uma chave nossa (namespaced) e não uma URL externa (entrada do provedor)? */
export function ehChaveMidia(valor: string): boolean {
  return valor.startsWith('tenant/')
}
