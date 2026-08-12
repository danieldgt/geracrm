import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { rotasAuth } from './rotas-auth.js'

/**
 * Login/refresh server-side. O Cognito é externo — mockamos `fetch` para validar
 * o WIRING (params, shape da resposta), sem tocar a AWS.
 */
let app: FastifyInstance
const fetchMock = vi.fn()

beforeAll(async () => {
  process.env.COGNITO_CLIENT_ID = 'cid-teste'
  process.env.COGNITO_CLIENT_SECRET = 'segredo-teste'
  vi.stubGlobal('fetch', fetchMock)
  app = Fastify()
  await app.register(rotasAuth)
  await app.ready()
})
afterAll(async () => { await app.close(); vi.unstubAllGlobals() })
beforeEach(() => fetchMock.mockReset())

const cognitoOk = (extra: Record<string, unknown> = {}) =>
  fetchMock.mockResolvedValue({ status: 200, json: async () => ({ AuthenticationResult: { IdToken: 'id.tok.en', ExpiresIn: 3600, ...extra } }) })

describe('POST /v1/auth/login', () => {
  it('devolve idToken, expiraEm e refreshToken', async () => {
    cognitoOk({ RefreshToken: 'refresh.abc' })
    const antes = Date.now()
    const r = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { usuario: 'a@b.com', senha: 'x' } })
    expect(r.statusCode).toBe(200)
    const b = r.json() as { tipo: string; idToken: string; refreshToken: string; expiraEm: number }
    expect(b).toMatchObject({ tipo: 'ok', idToken: 'id.tok.en', refreshToken: 'refresh.abc' })
    // expiraEm ~ agora + 1h
    expect(b.expiraEm).toBeGreaterThanOrEqual(antes + 3600 * 1000 - 5000)
  })
})

describe('POST /v1/auth/refresh', () => {
  it('sem refreshToken/usuario → 400', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: 'só-token' } })
    expect(r.statusCode).toBe(400)
  })

  it('renova o idToken pelo REFRESH_TOKEN_AUTH (sem novo refresh token)', async () => {
    cognitoOk() // refresh não devolve RefreshToken
    const r = await app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: 'refresh.abc', usuario: 'a@b.com' } })
    expect(r.statusCode).toBe(200)
    const b = r.json() as { tipo: string; idToken: string; refreshToken?: string; expiraEm: number }
    expect(b).toMatchObject({ tipo: 'ok', idToken: 'id.tok.en' })
    expect(b.refreshToken).toBeUndefined()
    expect(b.expiraEm).toBeGreaterThan(Date.now())
    // ⚠️ Usou o fluxo de refresh, não senha.
    const corpo = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body) as { AuthFlow: string }
    expect(corpo.AuthFlow).toBe('REFRESH_TOKEN_AUTH')
  })

  it('refresh recusado pelo Cognito → 401', async () => {
    fetchMock.mockResolvedValue({ status: 200, json: async () => ({ __type: 'NotAuthorizedException', message: 'Refresh Token has expired' }) })
    const r = await app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: 'velho', usuario: 'a@b.com' } })
    expect(r.statusCode).toBe(401)
  })
})
