import { createHash, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import type { FastifyRequest } from 'fastify'

/**
 * IP do cliente para limite de taxa e auditoria — a ÚNICA função que as rotas usam (nunca `req.ip` direto).
 *
 * Caminhos até a API:
 *  - direto (app Expo, chamada ao domínio público da API): `req.ip` com 1 salto de `trustProxy` é o IP que a
 *    borda do Railway viu. Um `X-Forwarded-For` forjado fica à esquerda e é ignorado.
 *  - pelo nginx do console (`/publico`, `/v1`): a borda da API só vê o IP do nginx. O nginx apaga qualquer
 *    `X-Geracrm-*` vindo do cliente e acrescenta `X-Geracrm-Ip-Cliente` (o IP que a borda DELE viu) e
 *    `X-Geracrm-Proxy` (segredo compartilhado, `PROXY_SEGREDO` nos dois serviços). A API só confia no IP do
 *    cabeçalho quando o segredo confere, em tempo constante.
 *
 * ⚠️ Sem `PROXY_SEGREDO` configurado, os cabeçalhos são ignorados (comportamento seguro: 1 salto).
 * Por que não 2 saltos: o domínio da API é público; com 2 saltos quem chama direto escolheria o próprio IP.
 */
export const CABECALHO_IP_CLIENTE = 'x-geracrm-ip-cliente'
export const CABECALHO_PROXY = 'x-geracrm-proxy'

function hash(s: string): Buffer {
  return createHash('sha256').update(s).digest()
}

/** Comparação em tempo constante (hash antes: `timingSafeEqual` exige o mesmo tamanho). */
export function segredoConfere(recebido: string | undefined, esperado: string | undefined): boolean {
  if (!esperado || !recebido) return false
  return timingSafeEqual(hash(recebido), hash(esperado))
}

function unico(v: string | string[] | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined
}

export function ipDoCliente(req: FastifyRequest, segredo = process.env.PROXY_SEGREDO): string {
  const esperado = segredo?.trim()
  if (esperado && segredoConfere(unico(req.headers[CABECALHO_PROXY]), esperado)) {
    const ip = unico(req.headers[CABECALHO_IP_CLIENTE])?.trim()
    if (ip && isIP(ip)) return ip
  }
  return req.ip
}
