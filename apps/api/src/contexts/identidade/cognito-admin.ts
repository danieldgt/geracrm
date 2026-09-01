import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminAddUserToGroupCommand,
  UsernameExistsException,
} from '@aws-sdk/client-cognito-identity-provider'

/**
 * Criação do login do cliente no Cognito — o par administrativo do
 * `rotas-auth.ts` (que só faz `InitiateAuth`).
 *
 * ⚠️ Exige credencial IAM no ambiente da API (`AWS_ACCESS_KEY_ID` /
 * `AWS_SECRET_ACCESS_KEY`), com uma policy MÍNIMA sobre o ARN do pool:
 * `AdminCreateUser`, `AdminSetUserPassword`, `AdminAddUserToGroup`. Não é a
 * mesma credencial de operação — e nunca deve ser uma com acesso amplo.
 *
 * ⚠️ `custom:tenant_id` é IMUTÁVEL no pool (`Mutable: false`): ele é gravado
 * aqui, na criação, e não há como corrigir depois. Um e-mail pertence a um
 * tenant para sempre; trocar exige apagar e recriar o usuário. Por isso o
 * tenant é validado ANTES de chegar aqui.
 *
 * ⚠️ A senha é definida como PERMANENTE (`AdminSetUserPassword` com
 * `Permanent: true`) em vez do convite por e-mail da AWS: o cliente entra com a
 * senha que o staff combinou com ele, sem depender de e-mail chegar (e sem o
 * estado `FORCE_CHANGE_PASSWORD`, que o nosso login server-side trataria como
 * desafio).
 */

export class CognitoAdminIndisponivel extends Error {
  constructor() {
    super('cognito-admin: faltam COGNITO_USER_POOL_ID ou credenciais AWS na API')
    this.name = 'CognitoAdminIndisponivel'
  }
}

export class EmailJaExiste extends Error {
  constructor(email: string) {
    super(`cognito-admin: ${email} já existe no pool`)
    this.name = 'EmailJaExiste'
  }
}

export interface UsuarioCriado {
  readonly sub: string
  readonly email: string
}

function cliente(): { client: CognitoIdentityProviderClient; poolId: string } {
  const poolId = process.env.COGNITO_USER_POOL_ID
  const temCredencial = Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)
  if (!poolId || !temCredencial) throw new CognitoAdminIndisponivel()
  return {
    client: new CognitoIdentityProviderClient({ region: process.env.COGNITO_REGION ?? 'us-east-1' }),
    poolId,
  }
}

/** A API consegue criar login? A tela usa isto para avisar ANTES de o staff preencher o formulário. */
export function cognitoAdminConfigurado(): boolean {
  return Boolean(
    process.env.COGNITO_USER_POOL_ID && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY,
  )
}

export async function criarUsuarioCognito(params: {
  email: string
  nome: string
  tenantId: string
  senha: string
  grupos?: readonly string[]
}): Promise<UsuarioCriado> {
  const { client, poolId } = cliente()
  const email = params.email.trim().toLowerCase()

  let sub: string
  try {
    const criado = await client.send(new AdminCreateUserCommand({
      UserPoolId: poolId,
      Username: email,
      // ⚠️ SUPPRESS: nós definimos a senha logo abaixo. Sem isto a AWS manda o
      //    convite dela, com uma senha temporária que ninguém vai usar.
      MessageAction: 'SUPPRESS',
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'name', Value: params.nome.trim() },
        { Name: 'custom:tenant_id', Value: params.tenantId },
      ],
    }))
    sub = criado.User?.Attributes?.find((a) => a.Name === 'sub')?.Value ?? ''
  } catch (e) {
    if (e instanceof UsernameExistsException) throw new EmailJaExiste(email)
    throw e
  }

  await client.send(new AdminSetUserPasswordCommand({
    UserPoolId: poolId,
    Username: email,
    Password: params.senha,
    Permanent: true,
  }))

  for (const grupo of params.grupos ?? []) {
    await client.send(new AdminAddUserToGroupCommand({
      UserPoolId: poolId, Username: email, GroupName: grupo,
    }))
  }

  return { sub, email }
}
