import { describe, it, expect } from 'vitest'
import { conteudoDaMensagemMeta, parseWebhookMeta } from './meta.js'

/**
 * Parsing de MÍDIA e de resposta de botão do webhook da Meta (R5) — fixtures
 * reais (encurtadas) da Cloud API, puro, sem rede.
 */
const envelope = (mensagem: Record<string, unknown>) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA1', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '5581999990000', phone_number_id: 'PHONE-R5' },
    contacts: [{ profile: { name: 'Maria' }, wa_id: '5581988887777' }],
    messages: [{ from: '5581988887777', id: 'wamid.R5', timestamp: '1690000000', ...mensagem }],
  } }] }],
})

describe('conteudoDaMensagemMeta', () => {
  it('imagem: media id, mime e legenda (a Meta não manda URL)', () => {
    expect(conteudoDaMensagemMeta({ type: 'image', image: { id: '1234567890', mime_type: 'image/jpeg', sha256: 'abc', caption: 'olha essa' } }))
      .toEqual({ tipo: 'imagem', midiaId: '1234567890', mime: 'image/jpeg', legenda: 'olha essa' })
    expect(conteudoDaMensagemMeta({ type: 'image', image: { id: '42', mime_type: 'image/png' } }))
      .toEqual({ tipo: 'imagem', midiaId: '42', mime: 'image/png', legenda: null })
  })

  it('áudio (mensagem de voz): media id e mime com codecs', () => {
    expect(conteudoDaMensagemMeta({ type: 'audio', audio: { id: '9876', mime_type: 'audio/ogg; codecs=opus', voice: true } }))
      .toEqual({ tipo: 'audio', midiaId: '9876', mime: 'audio/ogg; codecs=opus' })
  })

  it('resposta de botão interativo vira TEXTO (o título) com o id do botão', () => {
    expect(conteudoDaMensagemMeta({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'confirmar', title: 'Confirmar' } } }))
      .toEqual({ tipo: 'texto', texto: 'Confirmar', botaoId: 'confirmar' })
    expect(conteudoDaMensagemMeta({ type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'opt-2', title: 'Tamanho G', description: 'x' } } }))
      .toEqual({ tipo: 'texto', texto: 'Tamanho G', botaoId: 'opt-2' })
    // Quick reply de template.
    expect(conteudoDaMensagemMeta({ type: 'button', button: { payload: 'SIM', text: 'Sim, confirmar' } }))
      .toEqual({ tipo: 'texto', texto: 'Sim, confirmar', botaoId: 'SIM' })
  })

  it('tipos ainda não ingeridos são reconhecidos com o tipo cru, nunca descartados em silêncio', () => {
    expect(conteudoDaMensagemMeta({ type: 'video', video: { id: '1' } })).toEqual({ tipo: 'outro', tipoCru: 'video' })
    expect(conteudoDaMensagemMeta({ type: 'image', image: {} })).toEqual({ tipo: 'outro', tipoCru: 'image_sem_id' })
    expect(conteudoDaMensagemMeta({})).toEqual({ tipo: 'outro', tipoCru: 'desconhecido' })
  })

  it('parseWebhookMeta carrega o conteúdo de mídia no evento de mensagem', () => {
    const [ev] = parseWebhookMeta(envelope({ type: 'audio', audio: { id: '777', mime_type: 'audio/ogg' } }))
    expect(ev).toMatchObject({ tipo: 'mensagem', phoneNumberId: 'PHONE-R5', idExterno: 'wamid.R5', conteudo: { tipo: 'audio', midiaId: '777' } })
  })
})
