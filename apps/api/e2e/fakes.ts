import { createServer, type IncomingMessage, type Server } from 'node:http'

/**
 * Servidores HTTP falsos, locais. Cada um grava o que recebe e o expõe em
 * `GET /__registro` (o teste roda em outro processo que o servidor falso).
 */
export interface Registro { metodo: string; caminho: string; corpo: unknown }

function lerCorpo(req: IncomingMessage): Promise<string> {
  return new Promise((ok) => {
    const partes: Buffer[] = []
    req.on('data', (c: Buffer) => partes.push(c))
    req.on('end', () => ok(Buffer.concat(partes).toString('utf8')))
  })
}
const json = (s: string): unknown => { try { return JSON.parse(s) } catch { return s } }

function subir(porta: number, tratar: (r: Registro, url: URL) => { status: number; corpo: unknown } | null): Promise<Server> {
  const registros: Registro[] = []
  const srv = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/__registro') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(registros))
      return
    }
    const corpo = json(await lerCorpo(req))
    const reg: Registro = { metodo: req.method ?? 'GET', caminho: url.pathname + url.search, corpo }
    registros.push(reg)
    const r = tratar(reg, url) ?? { status: 404, corpo: { erro: 'fake.rota_desconhecida' } }
    res.writeHead(r.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(r.corpo))
  })
  return new Promise((ok) => srv.listen(porta, '127.0.0.1', () => ok(srv)))
}

/** Faz de conta a Graph API da Meta (Cloud API): aceita envios e devolve um wamid. */
export function subirMetaFalsa(porta: number): Promise<Server> {
  let n = 0
  return subir(porta, (r) => {
    if (r.metodo === 'POST' && r.caminho.endsWith('/messages')) {
      n += 1
      return { status: 200, corpo: { messaging_product: 'whatsapp', contacts: [{ wa_id: 'x' }], messages: [{ id: `wamid.FAKE-OUT-${n}` }] } }
    }
    return null
  })
}

/**
 * Faz de conta o GeraCloud (login do Keycloak + a API do ERP) no recorte que a
 * efetivação do pedido toca. Responde para QUALQUER SKU/cliente pedido: o teste
 * confere o que o produto MANDOU (`/__registro`), não o que o ERP sabe.
 */
export function subirErpFalso(porta: number): Promise<Server> {
  return subir(porta, (r, url) => {
    const p = url.pathname
    if (r.metodo === 'POST' && p === '/token') return { status: 200, corpo: { access_token: 'token-e2e', expires_in: 3600 } }
    const filtro = url.searchParams.get('filtro') ?? ''
    if (p === '/clientespdv') return { status: 200, corpo: [{ id: filtro, nome: 'Cliente ERP' }] }
    if (p === '/estoques') return { status: 200, corpo: [{ id: filtro, codigoBarra: { id: 9001 } }] }
    if (p === '/catalogos') return { status: 200, corpo: [{ id: 1, status: 0, tabelaPreco: { id: 7 } }] }
    if (/^\/tabela-preco\/\d+\/precos$/.test(p)) return { status: 200, corpo: [{ codigoBarra: { id: 9001 }, preco: 1 }] }
    if (r.metodo === 'POST' && p === '/catalogos-publico/orcamento') return { status: 200, corpo: {} }
    return null
  })
}
