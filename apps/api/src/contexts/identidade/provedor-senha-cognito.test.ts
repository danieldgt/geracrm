import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { provedorSenhaCognito } from './provedor-senha-cognito.js'

/** Adaptador Cognito da porta de senha: `fetch` mockado — valida o WIRING e o mapeamento de erros. */
const fetchMock = vi.fn()
const resp = (corpo: object, status = 200) => ({ status, json: async () => corpo })
const alvos = () => fetchMock.mock.calls.map((c) => (c[1] as { headers: Record<string, string> }).headers['x-amz-target']!.split('.').pop())
const corpoDa = (i: number) => JSON.parse((fetchMock.mock.calls[i]![1] as { body: string }).body) as Record<string, unknown>

beforeAll(() => {
  process.env.COGNITO_CLIENT_ID = 'cid-teste'
  process.env.COGNITO_CLIENT_SECRET = 'segredo-teste'
  vi.stubGlobal('fetch', fetchMock)
})
afterAll(() => vi.unstubAllGlobals())
beforeEach(() => fetchMock.mockReset())

const p = provedorSenhaCognito()

describe('trocarSenha', () => {
  it('confirma a senha atual (InitiateAuth) e troca com o access token (ChangePassword)', async () => {
    fetchMock
      .mockResolvedValueOnce(resp({ AuthenticationResult: { AccessToken: 'acesso.tok' } }))
      .mockResolvedValueOnce(resp({}))
    expect(await p.trocarSenha('Ana@Ex.com', 'Atual#1', 'Nova#123')).toEqual({ tipo: 'ok' })
    expect(alvos()).toEqual(['InitiateAuth', 'ChangePassword'])
    expect(corpoDa(0)['AuthParameters']).toMatchObject({ USERNAME: 'ana@ex.com', PASSWORD: 'Atual#1' })
    expect(corpoDa(1)).toMatchObject({ AccessToken: 'acesso.tok', PreviousPassword: 'Atual#1', ProposedPassword: 'Nova#123' })
  })

  it('senha atual errada não chega ao ChangePassword', async () => {
    fetchMock.mockResolvedValueOnce(resp({ __type: 'NotAuthorizedException' }, 400))
    expect(await p.trocarSenha('ana@ex.com', 'errada', 'Nova#123')).toEqual({ tipo: 'senha_atual_errada' })
    expect(alvos()).toEqual(['InitiateAuth'])
  })

  it('política de senha e limite viram retorno tipificado', async () => {
    fetchMock
      .mockResolvedValueOnce(resp({ AuthenticationResult: { AccessToken: 't' } }))
      .mockResolvedValueOnce(resp({ __type: 'InvalidPasswordException', message: 'Password did not conform with policy' }, 400))
    expect(await p.trocarSenha('ana@ex.com', 'a', 'b')).toEqual({ tipo: 'senha_invalida', mensagem: 'Password did not conform with policy' })
    fetchMock.mockResolvedValueOnce(resp({ __type: 'TooManyRequestsException' }, 400))
    expect(await p.trocarSenha('ana@ex.com', 'a', 'b')).toEqual({ tipo: 'limite' })
  })
})

describe('esqueci a senha', () => {
  it('é "ok" mesmo quando o provedor diz que o usuário não existe', async () => {
    fetchMock.mockResolvedValueOnce(resp({ __type: 'UserNotFoundException' }, 400))
    expect(await p.esqueciSenha('ninguem@ex.com')).toEqual({ tipo: 'ok' })
    fetchMock.mockRejectedValueOnce(new Error('rede'))
    expect(await p.esqueciSenha('ninguem@ex.com')).toEqual({ tipo: 'ok' })
    expect(corpoDa(0)).toMatchObject({ Username: 'ninguem@ex.com' })
  })

  it('confirmação: código errado e usuário inexistente são a mesma coisa; expirado e política têm nome', async () => {
    fetchMock.mockResolvedValueOnce(resp({ __type: 'CodeMismatchException' }, 400))
    expect(await p.confirmarEsqueciSenha('a@ex.com', '1', 'Nova#123')).toEqual({ tipo: 'codigo_invalido' })
    fetchMock.mockResolvedValueOnce(resp({ __type: 'UserNotFoundException' }, 400))
    expect(await p.confirmarEsqueciSenha('x@ex.com', '1', 'Nova#123')).toEqual({ tipo: 'codigo_invalido' })
    fetchMock.mockResolvedValueOnce(resp({ __type: 'ExpiredCodeException' }, 400))
    expect(await p.confirmarEsqueciSenha('a@ex.com', '1', 'Nova#123')).toEqual({ tipo: 'codigo_expirado' })
    fetchMock.mockResolvedValueOnce(resp({ __type: 'InvalidPasswordException', message: 'fraca' }, 400))
    expect(await p.confirmarEsqueciSenha('a@ex.com', '1', 'x')).toEqual({ tipo: 'senha_invalida', mensagem: 'fraca' })
    fetchMock.mockResolvedValueOnce(resp({}))
    expect(await p.confirmarEsqueciSenha('a@ex.com', '123456', 'Nova#123')).toEqual({ tipo: 'ok' })
  })
})
