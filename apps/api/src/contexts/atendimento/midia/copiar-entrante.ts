import { comTenantServico } from '../../../db/index.js'
import { subirMidia } from './armazenamento.js'
import { LIMITE_BYTES } from './dataurl.js'
import type { MidiaExterna } from '../ingestao-mensagem.js'

/**
 * Copia a mídia de ENTRADA da URL do provedor para o NOSSO bucket (E5-14).
 *
 * ⚠️ PÓS-COMMIT e best-effort: o fetch é rede e não pode segurar a transação da
 * ingestão. Se falhar (URL já expirou, provedor fora), a mensagem MANTÉM a URL
 * do provedor — a leitura da thread já passa URL http direto. Degrada, não quebra.
 *
 * ⚠️ Momento certo é logo após ingerir: a URL do provedor é mais efêmera do que
 * a nossa; copiar tarde é copiar link morto.
 */
const TIMEOUT_MS = 10_000

export async function copiarMidiaEntrante(tenantId: string, m: MidiaExterna): Promise<boolean> {
  const controle = new AbortController()
  const t = setTimeout(() => controle.abort(), TIMEOUT_MS)
  let bytes: Buffer
  let mime: string
  try {
    const resp = await fetch(m.url, { signal: controle.signal })
    if (!resp.ok) return false
    const buf = Buffer.from(await resp.arrayBuffer())
    // ⚠️ Teto de tamanho aqui também: a URL do provedor não passou pela nossa
    //    validação de upload, então não confiamos no tamanho de graça.
    if (buf.length === 0 || buf.length > LIMITE_BYTES) return false
    bytes = buf
    mime = m.mime || resp.headers.get('content-type') || (m.tipo === 'imagem' ? 'image/jpeg' : 'audio/ogg')
  } catch {
    return false
  } finally {
    clearTimeout(t)
  }

  const chave = await subirMidia(tenantId, bytes, mime)

  // Troca a URL do provedor pela nossa chave no conteúdo. Match por (id,
  // criado_em) — criado_em é o valor que NÓS inserimos (recebidaEm), exato.
  await comTenantServico(tenantId, async (tx) => {
    await tx`
      UPDATE mensagem
         SET conteudo = conteudo || ${JSON.stringify({ [m.tipo]: chave })}::jsonb
       WHERE tenant_id = tenant_atual() AND id = ${m.mensagemId} AND criado_em = ${m.mensagemCriadoEm}`
  })
  return true
}
