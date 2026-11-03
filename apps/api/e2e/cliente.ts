import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { META_APP_SECRET, RAIZ_API, TENANT, URL_API, URL_ERP, URL_META } from './ambiente.js'
import type { Registro } from './fakes.js'

/** Cliente HTTP da API de verdade — o mesmo cabeçalho de tenant de dev que os testes usam. */
export async function api<T = Record<string, unknown>>(
  metodo: string, caminho: string, corpo?: unknown,
): Promise<{ status: number; corpo: T }> {
  const r = await fetch(`${URL_API}${caminho}`, {
    method: metodo,
    headers: { 'x-tenant-id': TENANT, ...(corpo === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
  })
  const texto = await r.text()
  let json: unknown = texto
  try { json = JSON.parse(texto) } catch { /* não é JSON */ }
  return { status: r.status, corpo: json as T }
}

/** Espera `fn` devolver algo verdadeiro — workers rodam em segundo plano. */
export async function esperarAte<T>(
  descricao: string, fn: () => Promise<T | null | undefined | false>, ms = 30_000,
): Promise<T> {
  const limite = Date.now() + ms
  let ultimo: unknown
  for (;;) {
    try {
      const v = await fn()
      if (v) return v
    } catch (e) { ultimo = e }
    if (Date.now() > limite) throw new Error(`tempo esgotado esperando: ${descricao}${ultimo ? ` (${String(ultimo)})` : ''}`)
    await new Promise((ok) => setTimeout(ok, 250))
  }
}

export async function registroDe(servidor: 'meta' | 'erp'): Promise<Registro[]> {
  const r = await fetch(`${servidor === 'meta' ? URL_META : URL_ERP}/__registro`)
  return (await r.json()) as Registro[]
}

/** Textos enviados pela Cloud API falsa, na ordem. */
export async function enviosDaMeta(): Promise<{ para: string; texto: string }[]> {
  return (await registroDe('meta'))
    .filter((r) => r.metodo === 'POST' && r.caminho.endsWith('/messages') && (r.corpo as { type?: string }).type === 'text')
    .map((r) => {
      const c = r.corpo as { to?: string; text?: { body?: string } }
      return { para: c.to ?? '', texto: c.text?.body ?? '' }
    })
}

/** Fixture de mensagem entrante da Meta, assinada com o App Secret (HMAC-SHA256 do corpo cru). */
export async function webhookEntrante(p: { phoneNumberId: string; waId: string; wamid: string; texto: string }): Promise<number> {
  const modelo = readFileSync(resolve(RAIZ_API, 'e2e/fixtures/meta-mensagem-texto.json'), 'utf8')
  const corpo = modelo
    .replaceAll('__WABA_ID__', 'WABA-E2E')
    .replaceAll('__PHONE_NUMBER_ID__', p.phoneNumberId)
    .replaceAll('__WA_ID__', p.waId)
    .replaceAll('__WAMID__', p.wamid)
    .replaceAll('__TIMESTAMP__', String(Math.floor(Date.now() / 1000)))
    .replaceAll('__TEXTO__', p.texto)
  const assinatura = 'sha256=' + createHmac('sha256', META_APP_SECRET).update(Buffer.from(corpo)).digest('hex')
  const r = await fetch(`${URL_API}/webhooks/meta`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': assinatura },
    body: corpo,
  })
  return r.status
}

/** Replay do SSE (`/v1/eventos?desde=1`): os tipos de evento do outbox do tenant. */
export async function tiposDeEvento(): Promise<string[]> {
  const ac = new AbortController()
  const r = await fetch(`${URL_API}/v1/eventos?desde=1`, { headers: { 'x-tenant-id': TENANT }, signal: ac.signal })
  const leitor = r.body!.getReader()
  const tipos: string[] = []
  let resto = ''
  const fim = Date.now() + 1500
  try {
    while (Date.now() < fim) {
      const lido = await Promise.race([leitor.read(), new Promise<null>((ok) => setTimeout(() => ok(null), 400))])
      if (lido === null || lido.done) break
      resto += new TextDecoder().decode(lido.value)
      for (const m of resto.matchAll(/^event: (.+)$/gm)) tipos.push(m[1]!)
    }
  } finally { ac.abort() }
  return tipos
}
