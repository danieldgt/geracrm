import { describe, it, expect } from 'vitest'
import { TranscricaoGroqWhisper, MODELO_GROQ_PADRAO, URL_GROQ_TRANSCRICAO } from './groq-whisper.js'
import { transcricaoDoAmbiente } from './fabrica.js'
import { TranscricaoIndisponivel } from './porta.js'

/**
 * Adaptador de transcrição (Groq/Whisper) — fetch mockado por contrato com
 * respostas no formato real da API; o provedor nunca é chamado.
 */
function fakeFetch(status: number, corpo: unknown, capturar?: (url: string, init: RequestInit) => void): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    capturar?.(url, init)
    return { ok: status >= 200 && status < 300, status, json: async () => corpo } as Response
  }) as unknown as typeof fetch
}
const ogg = { bytes: Buffer.from([0x4f, 0x67, 0x67, 0x53, 1, 2, 3]), mime: 'audio/ogg; codecs=opus', idioma: 'pt' }

describe('TranscricaoGroqWhisper', () => {
  it('monta o multipart (arquivo com extensão certa, modelo, idioma) com o bearer e devolve texto/idioma/duração', async () => {
    let capturado: { url: string; init: RequestInit } | null = null
    const porta = new TranscricaoGroqWhisper({ apiKey: 'gsk-teste', buscar: fakeFetch(200, { text: '  quero duas camisetas verdes ', language: 'pt', duration: 2.4 }, (url, init) => { capturado = { url, init } }) })
    expect(porta.capacidades.transcreve).toBe(true)
    const r = await porta.transcrever(ogg)
    expect(r).toEqual({ ok: true, texto: 'quero duas camisetas verdes', idioma: 'pt', duracaoS: 2.4 })

    expect(capturado!.url).toBe(URL_GROQ_TRANSCRICAO)
    expect((capturado!.init.headers as Record<string, string>).authorization).toBe('Bearer gsk-teste')
    const form = capturado!.init.body as FormData
    expect(form.get('model')).toBe(MODELO_GROQ_PADRAO)
    expect(form.get('language')).toBe('pt')
    expect(form.get('response_format')).toBe('verbose_json')
    const arquivo = form.get('file') as File
    expect(arquivo.name).toBe('audio.ogg')
    expect(arquivo.type).toBe('audio/ogg')
    expect(arquivo.size).toBe(7)
  })

  it('modelo e URL são parâmetros: outro provedor compatível é só outra string', async () => {
    let url = ''
    let modelo: string | File | null = null
    const porta = new TranscricaoGroqWhisper({ apiKey: 'k', url: 'https://outro.exemplo/v1/audio/transcriptions', modelo: 'whisper-1', buscar: fakeFetch(200, { text: 'oi' }, (u, init) => { url = u; modelo = (init.body as FormData).get('model') }) })
    await porta.transcrever(ogg)
    expect(url).toBe('https://outro.exemplo/v1/audio/transcriptions')
    expect(modelo).toBe('whisper-1')
  })

  it('mapeia as falhas do provedor para motivos tipificados', async () => {
    const chave = new TranscricaoGroqWhisper({ apiKey: 'x', buscar: fakeFetch(401, { error: { message: 'Invalid API Key', type: 'invalid_request_error' } }) })
    expect(await chave.transcrever(ogg)).toMatchObject({ ok: false, motivo: 'credencial_invalida' })

    const fora = new TranscricaoGroqWhisper({ apiKey: 'x', buscar: fakeFetch(503, {}) })
    expect(await fora.transcrever(ogg)).toMatchObject({ ok: false, motivo: 'indisponivel' })

    const limite = new TranscricaoGroqWhisper({ apiKey: 'x', buscar: fakeFetch(429, { error: { message: 'Rate limit' } }) })
    expect(await limite.transcrever(ogg)).toMatchObject({ ok: false, motivo: 'indisponivel' })

    const grande = new TranscricaoGroqWhisper({ apiKey: 'x', buscar: fakeFetch(413, {}) })
    expect(await grande.transcrever(ogg)).toMatchObject({ ok: false, motivo: 'muito_longo' })

    const naoDecodifica = new TranscricaoGroqWhisper({ apiKey: 'x', buscar: fakeFetch(400, { error: { message: 'could not process file' } }) })
    expect(await naoDecodifica.transcrever(ogg)).toMatchObject({ ok: false, motivo: 'formato', detalhe: 'could not process file' })

    const rede = new TranscricaoGroqWhisper({ apiKey: 'x', buscar: (async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch })
    expect(await rede.transcrever(ogg)).toMatchObject({ ok: false, motivo: 'indisponivel', detalhe: 'ECONNRESET' })
  })

  it('recusa antes de chamar o provedor: áudio vazio e mime que ele não entende', async () => {
    let chamou = false
    const porta = new TranscricaoGroqWhisper({ apiKey: 'x', buscar: fakeFetch(200, { text: 'x' }, () => { chamou = true }) })
    expect(await porta.transcrever({ bytes: Buffer.alloc(0), mime: 'audio/ogg' })).toMatchObject({ ok: false, motivo: 'formato' })
    expect(await porta.transcrever({ bytes: Buffer.from([1]), mime: 'application/pdf' })).toMatchObject({ ok: false, motivo: 'formato' })
    expect(chamou).toBe(false)
  })
})

describe('transcricaoDoAmbiente', () => {
  it('sem GROQ_API_KEY → indisponível (capacidade false, nunca lança)', async () => {
    const porta = transcricaoDoAmbiente({} as NodeJS.ProcessEnv)
    expect(porta).toBe(TranscricaoIndisponivel)
    expect(porta.capacidades.transcreve).toBe(false)
    expect(await porta.transcrever(ogg)).toMatchObject({ ok: false, motivo: 'indisponivel' })
  })

  it('com GROQ_API_KEY → Groq/Whisper', () => {
    const porta = transcricaoDoAmbiente({ GROQ_API_KEY: 'gsk-x' } as NodeJS.ProcessEnv)
    expect(porta.nome).toBe('groq-whisper')
    expect(porta.capacidades.transcreve).toBe(true)
  })
})
