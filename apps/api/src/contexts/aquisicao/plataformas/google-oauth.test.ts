import { describe, it, expect } from 'vitest'
import { ProvedorTokenGoogle, traduzirErroOAuth } from './google-oauth.js'

function fakeFetch(respostas: { status: number; corpo: unknown }[], contar?: () => void): typeof fetch {
  let i = 0
  return (async () => {
    contar?.()
    const r = respostas[Math.min(i++, respostas.length - 1)]!
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.corpo } as Response
  }) as unknown as typeof fetch
}

const cred = { clientId: 'cid', clientSecret: 'sec', refreshToken: 'ref' }
const T0 = 1_700_000_000_000

describe('Provedor de access token', () => {
  it('troca o refresh por um access token', async () => {
    const p = new ProvedorTokenGoogle(cred, {
      buscar: fakeFetch([{ status: 200, corpo: { access_token: 'acc-1', expires_in: 3600 } }]),
      agora: () => T0,
    })
    expect(await p.obter()).toEqual({ ok: true, dados: 'acc-1' })
  })

  it('reusa o token em cache — não chama o Google de novo', async () => {
    let chamadas = 0
    const p = new ProvedorTokenGoogle(cred, {
      buscar: fakeFetch([{ status: 200, corpo: { access_token: 'acc-1', expires_in: 3600 } }], () => { chamadas++ }),
      agora: () => T0,
    })
    await p.obter(); await p.obter(); await p.obter()
    expect(chamadas).toBe(1)
  })

  // ⚠️ Renovar só quando expira deixaria uma janela em que o token vence no meio
  //    da chamada. A folga de 5 min evita o 401 intermitente — o pior tipo.
  it('renova ANTES de expirar, com folga', async () => {
    let chamadas = 0
    let agora = T0
    const p = new ProvedorTokenGoogle(cred, {
      buscar: fakeFetch([
        { status: 200, corpo: { access_token: 'acc-1', expires_in: 3600 } },
        { status: 200, corpo: { access_token: 'acc-2', expires_in: 3600 } },
      ], () => { chamadas++ }),
      agora: () => agora,
    })
    expect(await p.obter()).toMatchObject({ dados: 'acc-1' })

    agora = T0 + 3400 * 1000          // faltam 200s para expirar — dentro da folga
    expect(await p.obter()).toMatchObject({ dados: 'acc-2' })
    expect(chamadas).toBe(2)
  })

  it('falha de rede é indisponivel — a ação é esperar', async () => {
    const p = new ProvedorTokenGoogle(cred, {
      buscar: (async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch,
      agora: () => T0,
    })
    expect(await p.obter()).toMatchObject({ ok: false, motivo: 'indisponivel' })
  })
})

describe('Tradução do erro OAuth', () => {
  /**
   * ⚠️ `invalid_grant` sozinho não diz nada a quem está de plantão. O detalhe
   * carrega a instrução — inclusive a causa que se repete a cada 7 dias.
   */
  it('invalid_grant vira credencial_invalida COM instrução', () => {
    const r = traduzirErroOAuth('invalid_grant', undefined)
    expect(r.motivo).toBe('credencial_invalida')
    expect(r.detalhe).toContain('gere outro')
    expect(r.detalhe).toContain('Testing')   // a causa dos 7 dias
  })

  it('invalid_client aponta para client_id/secret', () => {
    expect(traduzirErroOAuth('invalid_client', undefined).detalhe).toContain('client_id')
  })

  it('rate limit é limite_de_taxa — o despachante não consome tentativa', () => {
    expect(traduzirErroOAuth('rate_limit_exceeded', 'devagar').motivo).toBe('limite_de_taxa')
  })

  it('o que não reconhecemos vira resposta_inesperada, não silêncio', () => {
    expect(traduzirErroOAuth('coisa_nova', 'sei la').motivo).toBe('resposta_inesperada')
  })
})
