import { describe, it, expect } from 'vitest'
import { CanalPlugZapi } from './canais/plugzapi.js'
import { CanalMetaOficial } from './canais/meta-oficial.js'
import { criarCanal } from './canais/fabrica.js'

/**
 * ⚠️ Testes do CONTRATO que o vigia usa. O incidente de 2026-08-24 aconteceu
 * porque ninguém perguntava se a sessão estava viva — então o que precisa ficar
 * protegido é a pergunta existir e ser feita só onde faz sentido.
 */
function fakeFetch(corpo: unknown, status = 200): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300, status, json: async () => corpo,
  })) as unknown as typeof fetch
}

describe('Quem pode cair, e quem não', () => {
  /**
   * ⚠️ O não-oficial automatiza um WhatsApp Web: o celular desliga e o número
   * para de enviar E de receber, sem erro em lugar nenhum.
   */
  it('PlugZapi declara que a sessão pode cair', () => {
    const c = new CanalPlugZapi({ instancia: 'i', token: 't' })
    expect(c.capacidades.sessaoPodeCair).toBe(true)
  })

  // ⚠️ O oficial é TOKEN, não sessão. Perguntar ali seria inventar verificação.
  it('Meta oficial declara que NÃO cai sozinho', () => {
    const c = new CanalMetaOficial({ phoneNumberId: 'p', token: 't' })
    expect(c.capacidades.sessaoPodeCair).toBe(false)
  })

  it('adaptador não implementado também não é vigiado', () => {
    expect(criarCanal('tiktok_business', {}).capacidades.sessaoPodeCair).toBe(false)
  })
})

describe('verificarConexao do PlugZapi', () => {
  /** A resposta REAL do incidente de 24/ago, como fixture. */
  const respostaDoIncidente = {
    connected: false, session: false, smartphoneConnected: false,
    error: 'You are not connected.',
  }

  it('reconhece a desconexão e devolve o motivo do fornecedor', async () => {
    const c = new CanalPlugZapi({ instancia: 'i', token: 't' }, { buscar: fakeFetch(respostaDoIncidente) })
    const r = await c.verificarConexao()
    expect(r.conectado).toBe(false)
    expect(r.detalhe).toBe('You are not connected.')
  })

  it('reconhece a conexão saudável', async () => {
    const c = new CanalPlugZapi({ instancia: 'i', token: 't' }, { buscar: fakeFetch({ connected: true }) })
    expect((await c.verificarConexao()).conectado).toBe(true)
  })

  /**
   * ⚠️ Fornecedor fora do ar NÃO pode ser lido como "conectado". Na dúvida, o
   * vigia precisa avisar — silêncio parecendo saúde é o modo de falha que este
   * módulo existe para eliminar.
   */
  it('falha de rede conta como NÃO conectado', async () => {
    const c = new CanalPlugZapi({ instancia: 'i', token: 't' }, {
      buscar: (async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch,
    })
    expect((await c.verificarConexao()).conectado).toBe(false)
  })

  it('resposta sem `connected` também não vira conectado', async () => {
    const c = new CanalPlugZapi({ instancia: 'i', token: 't' }, { buscar: fakeFetch({ algo: 'novo' }) })
    expect((await c.verificarConexao()).conectado).toBe(false)
  })
})
