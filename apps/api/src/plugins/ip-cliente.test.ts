import { afterEach, describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import { saltosDeProxy, saltosExcessivos } from '../app.js'
import { ipDoCliente } from './ip-cliente.js'
import { barrarPorIpGlobal, TETO_PUBLICO_POR_IP } from '../contexts/aquisicao/limite-publico.js'

// Fastify real com 1 salto (o que `criarApp` usa) e uma rota que devolve o IP resolvido.
async function montar() {
  const app = Fastify({ trustProxy: saltosDeProxy() })
  app.get('/ip', async (req) => ({ ip: ipDoCliente(req), reqIp: req.ip }))
  await app.ready()
  return app
}

const anterior = process.env.PROXY_SEGREDO
afterEach(() => {
  if (anterior === undefined) delete process.env.PROXY_SEGREDO
  else process.env.PROXY_SEGREDO = anterior
})

const chamar = async (headers: Record<string, string>, remoteAddress = '172.16.0.1') => {
  const app = await montar()
  const r = await app.inject({ method: 'GET', url: '/ip', headers, remoteAddress })
  await app.close()
  return r.json<{ ip: string; reqIp: string }>()
}

describe('ipDoCliente (F3c)', () => {
  it('chamada direta com X-Forwarded-For forjado não escolhe o IP (1 salto = o que a borda viu)', async () => {
    process.env.PROXY_SEGREDO = 's3gredo'
    const r = await chamar({ 'x-forwarded-for': '6.6.6.6, 7.7.7.7' })
    // Último valor = o que a borda acrescentou; o forjado fica à esquerda.
    expect(r.ip).toBe('7.7.7.7')
    const semXff = await chamar({})
    expect(semXff.ip).toBe('172.16.0.1')
  })

  it('segredo certo: usa o IP do cabeçalho do nginx', async () => {
    process.env.PROXY_SEGREDO = 's3gredo'
    const r = await chamar({ 'x-geracrm-proxy': 's3gredo', 'x-geracrm-ip-cliente': '203.0.113.9', 'x-forwarded-for': '9.9.9.9' })
    expect(r.ip).toBe('203.0.113.9')
  })

  it('segredo errado ou ausente: ignora o cabeçalho', async () => {
    process.env.PROXY_SEGREDO = 's3gredo'
    const errado = await chamar({ 'x-geracrm-proxy': 'outro', 'x-geracrm-ip-cliente': '203.0.113.9' })
    expect(errado.ip).toBe(errado.reqIp)
    const ausente = await chamar({ 'x-geracrm-ip-cliente': '203.0.113.9' })
    expect(ausente.ip).toBe(ausente.reqIp)
  })

  it('sem PROXY_SEGREDO configurado: ignora os cabeçalhos mesmo que venham (inclusive vazios)', async () => {
    delete process.env.PROXY_SEGREDO
    const r = await chamar({ 'x-geracrm-proxy': 'qualquer', 'x-geracrm-ip-cliente': '203.0.113.9' })
    expect(r.ip).toBe(r.reqIp)
    process.env.PROXY_SEGREDO = ''
    const vazio = await chamar({ 'x-geracrm-proxy': '', 'x-geracrm-ip-cliente': '203.0.113.9' })
    expect(vazio.ip).toBe(vazio.reqIp)
  })

  it('segredo certo mas IP inválido no cabeçalho: cai no req.ip', async () => {
    process.env.PROXY_SEGREDO = 's3gredo'
    const r = await chamar({ 'x-geracrm-proxy': 's3gredo', 'x-geracrm-ip-cliente': 'nao-e-ip' })
    expect(r.ip).toBe(r.reqIp)
  })
})

describe('TRUST_PROXY_HOPS', () => {
  it('só aceita 1 (ou 0 para desligar); mais que 1 volta para 1 e é sinalizado', () => {
    expect(saltosDeProxy(undefined)).toBe(1)
    expect(saltosDeProxy('2')).toBe(1)
    expect(saltosDeProxy('0')).toBe(false)
    expect(saltosExcessivos('2')).toBe(true)
    expect(saltosExcessivos('1')).toBe(false)
  })
})

describe('limitador global por IP das rotas públicas', () => {
  it('10 mil chaves aleatórias do mesmo IP são barradas após o teto, sem tocar em mapa por chave', () => {
    const agora = Date.now()
    let liberadas = 0
    for (let i = 0; i < 10_000; i++) {
      if (barrarPorIpGlobal('198.51.100.7', agora).permitido) liberadas++
    }
    expect(liberadas).toBe(TETO_PUBLICO_POR_IP)
    // Outro IP (legítimo) segue livre.
    expect(barrarPorIpGlobal('198.51.100.8', agora).permitido).toBe(true)
  })
})
