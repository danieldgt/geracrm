import { describe, it, expect } from 'vitest'
import { CanalMetaOficial, CAPACIDADES_META_OFICIAL } from './meta-oficial.js'

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

/** Ritmo humano e capacidades (R5): "digitando…", botões e download de mídia. */
describe('CanalMetaOficial — capacidades R5', () => {
  const caps = CAPACIDADES_META_OFICIAL

  it('declara digitação e mensagens interativas', () => {
    expect(caps.indicaDigitacao).toBe(true)
    expect(caps.mensagensInterativas).toBe(true)
  })

  it.skipIf(!caps.indicaDigitacao)('indicarDigitacao: marca lida + typing_indicator numa chamada só, e nunca lança', async () => {
    const chamadas: { url: string; init: RequestInit }[] = []
    const canal = new CanalMetaOficial(cred, { buscar: fakeFetch(200, { success: true }, (url, init) => { chamadas.push({ url, init }) }) })
    await canal.indicarDigitacao('5581988887777', 'wamid.CLIENTE1')
    expect(chamadas).toHaveLength(1)
    expect(chamadas[0]!.url).toBe('https://graph.facebook.com/v21.0/PHONE99/messages')
    expect((chamadas[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer tok-secreto')
    expect(JSON.parse(chamadas[0]!.init.body as string)).toEqual({
      messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.CLIENTE1', typing_indicator: { type: 'text' },
    })

    // Sem id da mensagem do cliente não há o que marcar: sai quieto, sem chamada.
    await canal.indicarDigitacao('5581988887777')
    expect(chamadas).toHaveLength(1)

    // Meta fora: best-effort, não lança.
    const fora = new CanalMetaOficial(cred, { buscar: (async () => { throw new Error('rede') }) as unknown as typeof fetch })
    await expect(fora.indicarDigitacao('5581988887777', 'wamid.X')).resolves.toBeUndefined()
  })

  it.skipIf(!caps.mensagensInterativas)('enviarBotoes: interactive/button com até 3 botões e título de até 20 caracteres', async () => {
    let capturado: RequestInit | null = null
    const canal = new CanalMetaOficial(cred, { buscar: fakeFetch(200, { messages: [{ id: 'wamid.BTN' }] }, (_u, init) => { capturado = init }) })
    const r = await canal.enviarBotoes('+5581988887777', 'Confirma o pedido?', [
      { id: 'confirmar', titulo: 'Confirmar' },
      { id: 'alterar', titulo: 'Alterar alguma coisa do pedido' },
      { id: 'c', titulo: 'C' },
      { id: 'd', titulo: 'Quarto botão não cabe' },
    ])
    expect(r).toEqual({ ok: true, idExterno: 'wamid.BTN' })
    const corpo = JSON.parse(capturado!.body as string)
    expect(corpo).toMatchObject({ to: '5581988887777', type: 'interactive', interactive: { type: 'button', body: { text: 'Confirma o pedido?' } } })
    const botoes = corpo.interactive.action.buttons as { type: string; reply: { id: string; title: string } }[]
    expect(botoes).toHaveLength(3)
    expect(botoes[0]).toEqual({ type: 'reply', reply: { id: 'confirmar', title: 'Confirmar' } })
    expect(botoes[1]!.reply.title).toBe('Alterar alguma coisa')
    expect(botoes[1]!.reply.title.length).toBeLessThanOrEqual(20)
  })

  it('enviarBotoes sem botões degrada para texto simples', async () => {
    let capturado: RequestInit | null = null
    const canal = new CanalMetaOficial(cred, { buscar: fakeFetch(200, { messages: [{ id: 'wamid.T' }] }, (_u, init) => { capturado = init }) })
    await canal.enviarBotoes('5581988887777', 'oi', [])
    expect(JSON.parse(capturado!.body as string)).toMatchObject({ type: 'text', text: { body: 'oi' } })
  })

  it('baixarMidia: GET /{media_id} → URL assinada → bytes, os dois com o token', async () => {
    const chamadas: { url: string; init: RequestInit }[] = []
    const buscar = (async (url: string, init: RequestInit) => {
      chamadas.push({ url, init })
      if (url.endsWith('/MEDIA123')) {
        return { ok: true, status: 200, json: async () => ({ url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=MEDIA123', mime_type: 'audio/ogg', file_size: 3, id: 'MEDIA123' }) } as Response
      }
      return { ok: true, status: 200, headers: new Headers({ 'content-type': 'audio/ogg' }), arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } as unknown as Response
    }) as unknown as typeof fetch
    const canal = new CanalMetaOficial(cred, { buscar })
    const r = await canal.baixarMidia('MEDIA123')
    expect(r.ok).toBe(true)
    if (r.ok) { expect(r.mime).toBe('audio/ogg'); expect([...r.bytes]).toEqual([1, 2, 3]) }
    expect(chamadas[0]!.url).toBe('https://graph.facebook.com/v21.0/MEDIA123')
    expect((chamadas[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer tok-secreto')
    expect(chamadas[1]!.url).toContain('lookaside.fbsbx.com')
    expect((chamadas[1]!.init.headers as Record<string, string>).authorization).toBe('Bearer tok-secreto')
  })

  it('baixarMidia: mídia expirada/inexistente e token recusado viram motivos tipificados', async () => {
    const sumiu = new CanalMetaOficial(cred, { buscar: fakeFetch(404, { error: { code: 100, message: 'Unsupported get request' } }) })
    expect(await sumiu.baixarMidia('X')).toMatchObject({ ok: false, motivo: 'nao_encontrada' })
    const token = new CanalMetaOficial(cred, { buscar: fakeFetch(401, { error: { code: 190 } }) })
    expect(await token.baixarMidia('X')).toMatchObject({ ok: false, motivo: 'credencial_invalida' })
  })
})
