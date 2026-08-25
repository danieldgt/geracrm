import { describe, it, expect, vi } from 'vitest'
import { avaliarEnvio, enviarPeloGateway, type ContextoEnvio } from './gateway.js'

/**
 * E5-13 — o gateway único revalida os guardrails NO SERVIDOR. Estes testes
 * fixam a política; se alguém afrouxar um guard, um deles quebra.
 */
const AGORA = new Date('2026-08-09T12:00:00Z')
const H = 60 * 60 * 1000

const base: ContextoEnvio = {
  tipoCanal: 'whatsapp_nao_oficial',
  estadoCanal: 'conectado',
  provedor: 'plugzapi',
  temCredencial: true,
  destinoBloqueado: false,
  ehTemplate: false,
  ultimaEntranteEm: null,
}

describe('avaliarEnvio: ordem e política dos guardrails', () => {
  it('libera o caminho feliz do não-oficial (texto livre sempre)', () => {
    expect(avaliarEnvio(base, AGORA)).toEqual({ libera: true })
  })

  it('⚠️ opt-out vence tudo — mesmo com canal e credencial perfeitos', () => {
    const r = avaliarEnvio({ ...base, destinoBloqueado: true }, AGORA)
    expect(r).toEqual({ libera: false, motivo: 'bloqueado' })
  })

  it('opt-out é checado ANTES do estado do canal', () => {
    // Canal desconectado E bloqueado: o motivo tem de ser o bloqueio (1ª barreira).
    const r = avaliarEnvio({ ...base, destinoBloqueado: true, estadoCanal: 'desconectado' }, AGORA)
    expect(r).toEqual({ libera: false, motivo: 'bloqueado' })
  })

  it('canal suspenso ou desconectado não envia; degradado ainda envia', () => {
    expect(avaliarEnvio({ ...base, estadoCanal: 'suspenso' }, AGORA)).toEqual({ libera: false, motivo: 'canal_indisponivel' })
    expect(avaliarEnvio({ ...base, estadoCanal: 'desconectado' }, AGORA)).toEqual({ libera: false, motivo: 'canal_indisponivel' })
    expect(avaliarEnvio({ ...base, estadoCanal: 'degradado' }, AGORA)).toEqual({ libera: true })
  })

  it('sem provedor ou sem credencial → canal_sem_credencial', () => {
    expect(avaliarEnvio({ ...base, provedor: null }, AGORA)).toEqual({ libera: false, motivo: 'canal_sem_credencial' })
    expect(avaliarEnvio({ ...base, temCredencial: false }, AGORA)).toEqual({ libera: false, motivo: 'canal_sem_credencial' })
  })

  describe('janela de 24h — só o oficial', () => {
    const oficial: ContextoEnvio = { ...base, tipoCanal: 'whatsapp_oficial', provedor: 'meta_oficial' }

    it('oficial com janela ABERTA (entrante há 1h) libera', () => {
      const r = avaliarEnvio({ ...oficial, ultimaEntranteEm: new Date(AGORA.getTime() - 1 * H) }, AGORA)
      expect(r).toEqual({ libera: true })
    })

    it('⚠️ oficial com janela FECHADA (entrante há 25h) e sem template → janela_fechada', () => {
      const r = avaliarEnvio({ ...oficial, ultimaEntranteEm: new Date(AGORA.getTime() - 25 * H) }, AGORA)
      expect(r).toEqual({ libera: false, motivo: 'janela_fechada' })
    })

    it('oficial nunca teve entrante (null) → janela fechada', () => {
      expect(avaliarEnvio({ ...oficial, ultimaEntranteEm: null }, AGORA)).toEqual({ libera: false, motivo: 'janela_fechada' })
    })

    it('template aprovado reabre: libera mesmo com janela fechada', () => {
      const r = avaliarEnvio({ ...oficial, ultimaEntranteEm: null, ehTemplate: true }, AGORA)
      expect(r).toEqual({ libera: true })
    })

    it('⚠️ não-oficial NÃO cai na janela: texto livre mesmo sem nenhuma entrante', () => {
      expect(avaliarEnvio({ ...base, ultimaEntranteEm: null }, AGORA)).toEqual({ libera: true })
    })
  })
})

describe('enviarPeloGateway: só despacha se liberado', () => {
  it('recusa NÃO chama o adaptador (o guard roda antes do despacho)', async () => {
    const despachar = vi.fn()
    const r = await enviarPeloGateway({ ...base, destinoBloqueado: true }, AGORA, despachar)
    expect(despachar).not.toHaveBeenCalled()
    expect(r).toEqual({ ok: false, classe: 'recusa', motivo: 'bloqueado' })
  })

  it('liberado despacha e propaga o id externo', async () => {
    const despachar = vi.fn().mockResolvedValue({ ok: true, idExterno: 'WA-123' })
    const r = await enviarPeloGateway(base, AGORA, despachar)
    expect(despachar).toHaveBeenCalledOnce()
    expect(r).toEqual({ ok: true, idExterno: 'WA-123' })
  })

  it('falha de transporte do fornecedor vira classe transporte', async () => {
    const despachar = vi.fn().mockResolvedValue({ ok: false, motivo: 'canal_desconectado', detalhe: 'instância caiu' })
    const r = await enviarPeloGateway(base, AGORA, despachar)
    expect(r).toEqual({ ok: false, classe: 'transporte', motivo: 'canal_desconectado', detalhe: 'instância caiu' })
  })
})

describe('⚠️ Pausa de disparo (CAN-06)', () => {
  const base = {
    tipoCanal: 'whatsapp_nao_oficial', estadoCanal: 'conectado', provedor: 'plugzapi',
    temCredencial: true, destinoBloqueado: false, ehTemplate: false,
    ultimaEntranteEm: new Date('2026-08-25T10:00:00Z'),
  }
  const AGORA = new Date('2026-08-25T11:00:00Z')

  it('com o disparo pausado, envio PROGRAMÁTICO é recusado com motivo próprio', () => {
    const d = avaliarEnvio({ ...base, ehDisparo: true, disparoPausado: true }, AGORA)
    expect(d).toEqual({ libera: false, motivo: 'disparo_pausado' })
  })

  /**
   * ⚠️ O ponto inteiro da pausa: ela protege o número do tráfego EM MASSA.
   * Travar a resposta de uma pessoa a quem acabou de escrever seria parar o
   * atendimento por causa do problema oposto — e a conversa iniciada pelo
   * cliente é o tráfego mais seguro que existe.
   */
  it('mas a resposta de uma pessoa continua saindo', () => {
    const d = avaliarEnvio({ ...base, ehDisparo: false, disparoPausado: true }, AGORA)
    expect(d).toEqual({ libera: true })
  })

  it('sem pausa, o disparo passa', () => {
    expect(avaliarEnvio({ ...base, ehDisparo: true, disparoPausado: false }, AGORA))
      .toEqual({ libera: true })
  })

  /** Opt-out vence tudo — inclusive a ordem em que a pausa foi colocada. */
  it('opt-out ainda vem antes da pausa', () => {
    const d = avaliarEnvio(
      { ...base, destinoBloqueado: true, ehDisparo: true, disparoPausado: true }, AGORA)
    expect(d).toEqual({ libera: false, motivo: 'bloqueado' })
  })

  /**
   * ⚠️ E a pausa vem ANTES das checagens técnicas: quem for ver por que o
   * disparo parou precisa ler "disparo pausado", não "canal indisponível".
   */
  it('pausa é reportada antes de canal indisponível', () => {
    const d = avaliarEnvio(
      { ...base, estadoCanal: 'desconectado', ehDisparo: true, disparoPausado: true }, AGORA)
    expect(d).toEqual({ libera: false, motivo: 'disparo_pausado' })
  })
})
