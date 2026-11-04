import { createHmac } from 'node:crypto'

/**
 * Chamadas ao Cognito pela API PÚBLICA (sem credencial IAM): é o app client CONFIDENCIAL que assina com
 * `SECRET_HASH`. O segredo vive só no servidor. Usado pelo login (`rotas-auth.ts`) e pelas senhas
 * (`provedor-senha-cognito.ts`).
 */

export interface RespostaCognito {
  AuthenticationResult?: { IdToken?: string; AccessToken?: string; RefreshToken?: string; ExpiresIn?: number }
  ChallengeName?: string
  Session?: string
  __type?: string
  message?: string
}

export const regiaoCognito = (): string => process.env.COGNITO_REGION ?? 'us-east-1'

export function secretHash(usuario: string, clientId: string, secret: string): string {
  return createHmac('sha256', secret).update(usuario + clientId).digest('base64')
}

export async function chamarCognito(alvo: string, corpo: object): Promise<{ status: number; corpo: RespostaCognito }> {
  const resp = await fetch(`https://cognito-idp.${regiaoCognito()}.amazonaws.com/`, {
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

/** O nome curto do erro do Cognito (`NotAuthorizedException`), sem o prefixo de namespace. */
export const tipoDoErro = (r: RespostaCognito): string => (r.__type ?? '').split('#').pop() ?? ''
