import { describe, it, expect } from 'vitest'
import { ehDataUrl, decodificarMidia, LIMITE_BYTES } from './dataurl.js'
import { ehChaveMidia } from './armazenamento.js'

/**
 * E5-14 — validação de mídia NO SERVIDOR. Fixa o que entra no bucket e o que é
 * recusado com motivo nomeado, sem tocar em rede.
 */
const b64 = (s: string) => Buffer.from(s).toString('base64')

describe('decodificarMidia: validação de tipo/tamanho', () => {
  it('aceita imagem PNG e devolve os bytes decodificados', () => {
    const r = decodificarMidia(`data:image/png;base64,${b64('PNGDATA')}`)
    expect(r.ok).toBe(true)
    if (r.ok) { expect(r.mime).toBe('image/png'); expect(r.bytes.toString()).toBe('PNGDATA') }
  })

  it('aceita áudio ogg (nota de voz)', () => {
    const r = decodificarMidia(`data:audio/ogg;base64,${b64('OGG')}`)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.mime).toBe('audio/ogg')
  })

  it('recusa formato que não é data URL base64', () => {
    expect(decodificarMidia('https://exemplo.com/foto.png')).toEqual({ ok: false, motivo: 'formato_invalido' })
    expect(decodificarMidia('data:image/png,sembase64')).toEqual({ ok: false, motivo: 'formato_invalido' })
  })

  it('recusa payload vazio', () => {
    expect(decodificarMidia('data:image/png;base64,')).toEqual({ ok: false, motivo: 'formato_invalido' })
  })

  it('⚠️ recusa tipo não suportado pelo WhatsApp (ex.: PDF, SVG)', () => {
    expect(decodificarMidia(`data:application/pdf;base64,${b64('x')}`)).toEqual({ ok: false, motivo: 'tipo_nao_suportado' })
    expect(decodificarMidia(`data:image/svg+xml;base64,${b64('x')}`)).toEqual({ ok: false, motivo: 'tipo_nao_suportado' })
  })

  it('⚠️ recusa acima de 16 MB', () => {
    // Gera base64 cujo decode passa do limite, sem alocar 16 MB de string real
    // caractere a caractere: usa um Buffer e serializa.
    const grande = Buffer.alloc(LIMITE_BYTES + 10, 1).toString('base64')
    expect(decodificarMidia(`data:image/jpeg;base64,${grande}`)).toEqual({ ok: false, motivo: 'muito_grande' })
  })

  it('exatamente no limite passa', () => {
    const noLimite = Buffer.alloc(LIMITE_BYTES, 1).toString('base64')
    const r = decodificarMidia(`data:image/jpeg;base64,${noLimite}`)
    expect(r.ok).toBe(true)
  })
})

describe('ehDataUrl / ehChaveMidia: distinguir upload novo de URL de entrada', () => {
  it('reconhece data URL', () => {
    expect(ehDataUrl(`data:image/png;base64,${b64('x')}`)).toBe(true)
    expect(ehDataUrl('https://provedor/foto.jpg')).toBe(false)
  })

  it('⚠️ chave nossa é namespaced por tenant; URL do provedor não', () => {
    expect(ehChaveMidia('tenant/6e7a0d00-0000-4000-8000-000000000001/abc.jpg')).toBe(true)
    // URL http do provedor (mídia de ENTRADA) não é chave — passa direto na leitura.
    expect(ehChaveMidia('https://storage.plugzapi/xyz.jpg')).toBe(false)
    expect(ehChaveMidia('data:image/png;base64,AAAA')).toBe(false)
  })
})
