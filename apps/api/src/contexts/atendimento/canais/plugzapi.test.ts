import { describe, it, expect } from 'vitest'
import { CanalPlugZapi } from './plugzapi.js'

/**
 * ⚠️ O que importa aqui é o MAPEAMENTO de falha: "instância desconectada" e
 * "número inválido" pedem ações opostas de quem opera. Colapsar em "erro"
 * produziria uma tela que não ajuda ninguém.
 */
const cred = { instancia: 'inst1', token: 'tok1', clientToken: 'ctk1' }

function fetchQueResponde(status: number, corpo: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(corpo), {
    status, headers: { 'content-type': 'application/json' },
  })) as typeof fetch
}

describe('CanalPlugZapi — envio', () => {
  it('declara capacidades de canal NÃO-oficial (sem janela, com risco)', () => {
    const c = new CanalPlugZapi(cred)
    expect(c.tipo).toBe('whatsapp_nao_oficial')
    expect(c.capacidades.janela24h).toBe(false)
    expect(c.capacidades.riscoBanimento).toBe(true) // o alerta que a tela mostra
  })

  it('dado envio ok, então devolve o id externo da mensagem', async () => {
    const c = new CanalPlugZapi(cred, { buscar: fetchQueResponde(200, { messageId: 'MSG123' }) })
    const r = await c.enviarTexto('5581998617049', 'oi')
    expect(r).toEqual({ ok: true, idExterno: 'MSG123' })
  })

  it('⚠️ instância desconectada → canal_desconectado (o celular caiu), não erro genérico', async () => {
    const c = new CanalPlugZapi(cred, {
      buscar: fetchQueResponde(400, { error: 'You are not connected. Please check your smartphone.' }),
    })
    const r = await c.enviarTexto('5581998617049', 'oi')
    expect(r).toMatchObject({ ok: false, motivo: 'canal_desconectado' })
  })

  it('⚠️ número inválido → destino_invalido (ação diferente de reconectar)', async () => {
    const c = new CanalPlugZapi(cred, {
      buscar: fetchQueResponde(400, { error: 'Phone number does not exist on WhatsApp' }),
    })
    const r = await c.enviarTexto('5581000000000', 'oi')
    expect(r).toMatchObject({ ok: false, motivo: 'destino_invalido' })
  })

  it('401 → credencial inválida (token/client-token)', async () => {
    const c = new CanalPlugZapi(cred, { buscar: fetchQueResponde(401, {}) })
    expect(await c.enviarTexto('5581998617049', 'oi')).toMatchObject({ ok: false, motivo: 'credencial_invalida' })
  })

  it('5xx → indisponível (a ação é esperar)', async () => {
    const c = new CanalPlugZapi(cred, { buscar: fetchQueResponde(503, {}) })
    expect(await c.enviarTexto('5581998617049', 'oi')).toMatchObject({ ok: false, motivo: 'indisponivel' })
  })

  it('⚠️ envia phone SEM o + e com Client-Token no header', async () => {
    let capturado: { url: string; init: RequestInit } | null = null
    const espiao: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturado = { url: String(url), init: init ?? {} }
      return new Response(JSON.stringify({ messageId: 'X' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    await new CanalPlugZapi(cred, { buscar: espiao }).enviarTexto('+5581998617049', 'oi')
    expect(capturado!.url).toContain('/instances/inst1/token/tok1/send-text')
    expect((capturado!.init.headers as Record<string, string>)['client-token']).toBe('ctk1')
    expect(JSON.parse(capturado!.init.body as string)).toEqual({ phone: '5581998617049', message: 'oi' })
  })
})
