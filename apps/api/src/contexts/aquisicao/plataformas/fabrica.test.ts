import { describe, it, expect } from 'vitest'
import { adaptadorDaPlataforma, configGoogleDoAmbiente, faltaParaGoogle } from './fabrica.js'

const completo = {
  GOOGLE_ADS_DEVELOPER_TOKEN: 'dev',
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: '123-276-0756',
  GOOGLE_OAUTH_CLIENT_ID: 'cid',
  GOOGLE_OAUTH_CLIENT_SECRET: 'sec',
  GOOGLE_OAUTH_REFRESH_TOKEN: 'ref',
} as NodeJS.ProcessEnv

describe('Configuração pelo ambiente', () => {
  it('com tudo presente, monta a configuração', () => {
    expect(configGoogleDoAmbiente(completo)).toMatchObject({ developerToken: 'dev', clientId: 'cid' })
  })

  // ⚠️ O painel mostra 123-276-0756, a API quer 1232760756. Aceitar os dois
  //    formatos evita um 403 que ninguém entende.
  it('normaliza o login-customer-id tirando os hífens', () => {
    expect(configGoogleDoAmbiente(completo)!.loginCustomerId).toBe('1232760756')
  })

  it('diz o que FALTA, pelo nome da variável', () => {
    const { GOOGLE_OAUTH_REFRESH_TOKEN: _, ...semToken } = completo
    expect(faltaParaGoogle(semToken as NodeJS.ProcessEnv)).toEqual(['GOOGLE_OAUTH_REFRESH_TOKEN'])
  })

  it('variável vazia conta como ausente', () => {
    expect(faltaParaGoogle({ ...completo, GOOGLE_ADS_DEVELOPER_TOKEN: '   ' })).toContain('GOOGLE_ADS_DEVELOPER_TOKEN')
  })

  it('sem nada, devolve null em vez de configuração pela metade', () => {
    expect(configGoogleDoAmbiente({} as NodeJS.ProcessEnv)).toBeNull()
  })
})

describe('Fábrica', () => {
  it('configurado, entrega o adaptador do Google com as capacidades reais', () => {
    const a = adaptadorDaPlataforma('google', { env: completo })
    expect(a.plataforma).toBe('google')
    expect(a.capacidades.leituraMetrica).toBe(true)
  })

  /**
   * ⚠️ Sem configuração NÃO devolve null nem lança: devolve um adaptador nomeado
   * com todas as capacidades em false. O despachante então DESCARTA com
   * `plataforma_sem_capacidade` — visível — em vez de tentar contra o vazio.
   */
  it('sem configuração, degrada em vez de quebrar', async () => {
    const a = adaptadorDaPlataforma('google', { env: {} as NodeJS.ProcessEnv })
    expect(a.capacidades.leituraMetrica).toBe(false)
    expect(a.capacidades.conversaoOffline).toBe(false)
    expect(await a.testarConexao()).toMatchObject({ ok: false, motivo: 'resposta_inesperada' })
  })

  it('plataforma ainda não implementada também degrada', () => {
    expect(adaptadorDaPlataforma('meta', { env: completo }).capacidades.leituraEstrutura).toBe(false)
  })
})
