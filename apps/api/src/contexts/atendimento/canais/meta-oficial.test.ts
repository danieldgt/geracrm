import { describe, it, expect } from 'vitest'
import { CanalMetaOficial } from './meta-oficial.js'

/** Adaptador WhatsApp Oficial (Graph API) — fetch mockado, Meta nunca é chamada. */
function fakeFetch(status: number, corpo: unknown, capturar?: (url: string, init: RequestInit) => void): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    capturar?.(url, init)
    return { ok: status >= 200 && status < 300, status, json: async () => corpo } as Response
  }) as unknown as typeof fetch
}

const cred = { phoneNumberId: 'PHONE99', token: 'tok-secreto' }

describe('CanalMetaOficial', () => {
  it('enviarTexto: monta a chamada da Graph API e devolve o id externo', async () => {
    let capturado: { url: string; init: RequestInit } | null = null
    const canal = new CanalMetaOficial(cred, { buscar: fakeFetch(200, { messages: [{ id: 'wamid.OUT1' }] }, (url, init) => { capturado = { url, init } }) })
    const r = await canal.enviarTexto('+5581988887777', 'olá')
    expect(r).toEqual({ ok: true, idExterno: 'wamid.OUT1' })
    expect(capturado!.url).toBe('https://graph.facebook.com/v21.0/PHONE99/messages')
    expect((capturado!.init.headers as Record<string, string>).authorization).toBe('Bearer tok-secreto')
    const corpo = JSON.parse(capturado!.init.body as string)
    expect(corpo).toMatchObject({ messaging_product: 'whatsapp', to: '5581988887777', type: 'text', text: { body: 'olá' } })
  })

  it('mapeia erros da Meta para motivos tipificados', async () => {
    const tok = new CanalMetaOficial(cred, { buscar: fakeFetch(401, { error: { code: 190, message: 'token' } }) })
    expect(await tok.enviarTexto('5581999990000', 'x')).toMatchObject({ ok: false, motivo: 'credencial_invalida' })

    const dest = new CanalMetaOficial(cred, { buscar: fakeFetch(400, { error: { code: 131030, message: 'not allowed' } }) })
    expect(await dest.enviarTexto('5581999990000', 'x')).toMatchObject({ ok: false, motivo: 'destino_invalido' })

    const rate = new CanalMetaOficial(cred, { buscar: fakeFetch(400, { error: { code: 131056, message: 'rate' } }) })
    expect(await rate.enviarTexto('5581999990000', 'x')).toMatchObject({ ok: false, motivo: 'indisponivel' })

    const off = new CanalMetaOficial(cred, { buscar: fakeFetch(500, {}) })
    expect(await off.enviarTexto('5581999990000', 'x')).toMatchObject({ ok: false, motivo: 'indisponivel' })
  })

  it('mídia base64 e apagar/editar: degrada honesto (limite da Cloud API)', async () => {
    const canal = new CanalMetaOficial(cred, { buscar: fakeFetch(200, { messages: [{ id: 'x' }] }) })
    expect(await canal.enviarImagem('5581999990000', 'data:image/png;base64,AAA')).toMatchObject({ ok: false, motivo: 'indisponivel' })
    expect(await canal.apagarMensagem()).toMatchObject({ ok: false, motivo: 'indisponivel' })
    expect(await canal.editarMensagem()).toMatchObject({ ok: false, motivo: 'indisponivel' })
  })

  it('enviarImagem com URL pública passa como link', async () => {
    let capturado: RequestInit | null = null
    const canal = new CanalMetaOficial(cred, { buscar: fakeFetch(200, { messages: [{ id: 'wamid.IMG' }] }, (_u, init) => { capturado = init }) })
    const r = await canal.enviarImagem('5581999990000', 'https://cdn.x/y.jpg', 'legenda')
    expect(r).toEqual({ ok: true, idExterno: 'wamid.IMG' })
    expect(JSON.parse(capturado!.body as string)).toMatchObject({ type: 'image', image: { link: 'https://cdn.x/y.jpg', caption: 'legenda' } })
  })
})
