import { comTenantServico, type Sql } from '../../../db/index.js'
import { decifrar } from '../../integracao/cofre.js'
import { criarCanal } from '../canais/fabrica.js'
import { PREFIXO_MIDIA_META } from '../canais/meta-oficial.js'
import { ehChaveMidia, midiaHabilitada, urlAssinada } from './armazenamento.js'
import { LIMITE_BYTES } from './dataurl.js'

/**
 * Baixa os BYTES de uma mídia de entrada, seja onde ela esteja:
 *   - `tenant/<T>/<uuid>.ext`  → nosso bucket (URL assinada curta);
 *   - `meta:media:<id>`        → Graph API, pelo adaptador do canal (token);
 *   - `http(s)://…`            → URL do provedor não-oficial.
 *
 * Um só lugar para a regra, usado pela resolução pós-webhook e pelo worker de
 * transcrição. ⚠️ Rede: nunca dentro de transação. Falha é `null` — quem chama
 * decide se tenta de novo (o worker conta tentativas).
 */
export interface DepsBaixar {
  readonly criar?: typeof criarCanal | undefined
  readonly buscar?: typeof fetch | undefined
  readonly timeoutMs?: number | undefined
}

export type MidiaBaixada = { bytes: Buffer; mime: string }

export function ehReferenciaMeta(ref: string): boolean {
  return ref.startsWith(PREFIXO_MIDIA_META)
}

export async function baixarMidiaDeEntrada(
  tenantId: string, canalId: string, ref: string, mimeSugerido: string | null, deps: DepsBaixar = {},
): Promise<MidiaBaixada | null> {
  if (ehReferenciaMeta(ref)) {
    const canal = await canalDoId(tenantId, canalId, deps.criar ?? criarCanal)
    if (!canal?.baixarMidia) return null
    const r = await canal.baixarMidia(ref.slice(PREFIXO_MIDIA_META.length))
    return r.ok ? { bytes: r.bytes, mime: mimeSugerido ?? r.mime } : null
  }

  let url: string
  if (ehChaveMidia(ref)) {
    if (!midiaHabilitada()) return null
    url = await urlAssinada(ref, 300)
  } else if (/^https?:\/\//i.test(ref)) {
    url = ref
  } else {
    return null
  }

  const buscar = deps.buscar ?? fetch
  const controle = new AbortController()
  const t = setTimeout(() => controle.abort(), deps.timeoutMs ?? 15_000)
  try {
    const resp = await buscar(url, { signal: controle.signal })
    if (!resp.ok) return null
    const bytes = Buffer.from(await resp.arrayBuffer())
    if (bytes.length === 0 || bytes.length > LIMITE_BYTES) return null
    return { bytes, mime: mimeSugerido ?? resp.headers.get('content-type') ?? 'application/octet-stream' }
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

/** Instancia o adaptador do canal a partir da credencial cifrada (sob RLS). */
async function canalDoId(tenantId: string, canalId: string, criar: typeof criarCanal) {
  const linha = await comTenantServico(tenantId, async (tx: Sql) => {
    const [c] = await tx<{ provedor: string | null; cred: Uint8Array | null }[]>`
      SELECT provedor, credenciais_cifradas AS cred FROM canal_conectado
       WHERE tenant_id = tenant_atual() AND id = ${canalId}`
    return c ?? null
  })
  if (!linha?.provedor || !linha.cred) return null
  return criar(linha.provedor, decifrar(Buffer.from(linha.cred)))
}
