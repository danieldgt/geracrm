import { createHmac } from 'node:crypto'
import type { FastifyInstance } from 'fastify'

/**
 * Login server-side — porque o app client do Cognito é CONFIDENCIAL (tem secret).
 *
 * ⚠️ Um SPA no browser não pode logar direto num client com secret: o
 * `SECRET_HASH` exigiria o secret no navegador. Então o secret vive AQUI, no
 * servidor, e o browser só troca usuário/senha por um ID token. O ID token
 * (que carrega `custom:tenant_id`) é o que a API já valida no resto das rotas.
 *
 * ⚠️ Rotas PÚBLICAS (sem exigirTenant): login não tem tenant ainda — é o login
 * que o revela.
 */

const REGIAO = process.env.COGNITO_REGION ?? 'us-east-1'

interface RespostaCognito {
  AuthenticationResult?: { IdToken?: string }
  ChallengeName?: string
  Session?: string
  __type?: string
  message?: string
}

function secretHash(usuario: string, clientId: string, secret: string): string {
  return createHmac('sha256', secret).update(usuario + clientId).digest('base64')
}

async function chamarCognito(alvo: string, corpo: object): Promise<{ status: number; corpo: RespostaCognito }> {
  const resp = await fetch(`https://cognito-idp.${REGIAO}.amazonaws.com/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': `AWSCognitoIdentityProviderService.${alvo}`,
    },
    body: JSON.stringify(corpo),
  })
  const corpoJson = (await resp.json().catch(() => ({}))) as RespostaCognito
  return { status: resp.status, corpo: corpoJson }
}

/** Erro cru do Cognito → mensagem que a tela pode mostrar. */
function traduzErro(r: RespostaCognito): string {
  const tipo = (r.__type ?? '').split('#').pop() ?? ''
  if (/NotAuthorized/i.test(tipo)) return 'Usuário ou senha incorretos.'
  if (/UserNotFound/i.test(tipo)) return 'Usuário não encontrado.'
  if (/PasswordResetRequired/i.test(tipo)) return 'É preciso redefinir a senha no painel.'
  if (/InvalidParameter|InvalidPassword/i.test(tipo)) return r.message ?? 'Parâmetro inválido.'
  if (/Too?ManyRequests|LimitExceeded/i.test(tipo)) return 'Muitas tentativas — aguarde um instante.'
  return r.message ?? tipo ?? 'Falha ao entrar.'
}

export async function rotasAuth(app: FastifyInstance): Promise<void> {
  const clientId = process.env.COGNITO_CLIENT_ID
  const secret = process.env.COGNITO_CLIENT_SECRET
  const configurado = Boolean(clientId && secret)

  app.post<{ Body: { usuario?: string; senha?: string } }>('/v1/auth/login', async (req, reply) => {
    if (!configurado) return reply.code(503).send({ tipo: 'erro', mensagem: 'Login indisponível: Cognito não configurado no servidor.' })
    const usuario = req.body?.usuario?.trim()
    const senha = req.body?.senha
    if (!usuario || !senha) return reply.code(400).send({ tipo: 'erro', mensagem: 'Usuário e senha são obrigatórios.' })

    const { status, corpo } = await chamarCognito('InitiateAuth', {
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: clientId,
      AuthParameters: { USERNAME: usuario, PASSWORD: senha, SECRET_HASH: secretHash(usuario, clientId!, secret!) },
    })

    const idToken = corpo.AuthenticationResult?.IdToken
    if (idToken) return reply.send({ tipo: 'ok', idToken })
    // Usuário criado pelo admin no primeiro acesso.
    if (corpo.ChallengeName === 'NEW_PASSWORD_REQUIRED' && corpo.Session) {
      return reply.send({ tipo: 'nova_senha', session: corpo.Session })
    }
    // Credencial errada é 401; config/flow é o status do Cognito.
    return reply.code(status === 200 ? 401 : status).send({ tipo: 'erro', mensagem: traduzErro(corpo) })
  })

  app.post<{ Body: { usuario?: string; novaSenha?: string; session?: string } }>('/v1/auth/nova-senha', async (req, reply) => {
    if (!configurado) return reply.code(503).send({ tipo: 'erro', mensagem: 'Login indisponível: Cognito não configurado no servidor.' })
    const usuario = req.body?.usuario?.trim()
    const novaSenha = req.body?.novaSenha
    const session = req.body?.session
    if (!usuario || !novaSenha || !session) return reply.code(400).send({ tipo: 'erro', mensagem: 'Dados incompletos para definir a nova senha.' })

    const { status, corpo } = await chamarCognito('RespondToAuthChallenge', {
      ChallengeName: 'NEW_PASSWORD_REQUIRED',
      ClientId: clientId,
      Session: session,
      ChallengeResponses: { USERNAME: usuario, NEW_PASSWORD: novaSenha, SECRET_HASH: secretHash(usuario, clientId!, secret!) },
    })

    const idToken = corpo.AuthenticationResult?.IdToken
    if (idToken) return reply.send({ tipo: 'ok', idToken })
    return reply.code(status === 200 ? 400 : status).send({ tipo: 'erro', mensagem: traduzErro(corpo) })
  })
}
